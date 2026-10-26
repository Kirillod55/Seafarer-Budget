// Groups 1–2 of spec §5: transfer, exchange, reconciliation (with «Сохранить»), NBU rate and conversion.
import { activeBalances, balances } from '../calc.ts'
import { money } from '../format.ts'
import { round2, usdRate } from '../fx.ts'
import { aliasMap, amountAt, extractAccount, fuzzyAccount, fuzzyCurrency, normalize, stripPunct } from '../parser.ts'
import type { Account, Transaction } from '../types.ts'
import { activeAccounts, dayMonth, defaultAccount, isMulti, load, partnerName, send, toOwner, usd } from './ctx.ts'
import type { Ctx, Snapshot } from './ctx.ts'
import { accountKey } from '../fuzzy.ts'
import type { BotReply } from './types.ts'

const SINGLE_MODE = 'Переводы между счетами — в режиме «Несколько счетов» (включается в приложении)'

interface Money { value: number; currency: string; at: number; length: number }

/** Every amount in the text with its currency (glued, symbol, or the word right after; else default). */
function amounts(tokens: string[], ctx: Ctx): Money[] {
  const aliases = aliasMap(ctx.settings.currencies)
  const out: Money[] = []
  for (let i = 0; i < tokens.length; i++) {
    const a = amountAt(tokens, i, aliases)
    if (!a) continue
    let currency = a.currency
    let length = a.length
    const next = tokens[i + a.length]
    if (!currency && next) {
      const f = fuzzyCurrency(next, aliases)
      if (f) {
        currency = f.code
        length++
      }
    }
    if (!currency && i > 0) {
      const f = aliases.get(stripPunct(tokens[i - 1]))
      if (f) currency = f
    }
    out.push({ value: a.value, currency: currency ?? ctx.settings.default_currency, at: i, length })
    i += length - 1
  }
  return out
}

/** The account a phrase names (exact name/alias, fuzzy key, «наличные» by its key). */
function accountIn(words: string[], snap: Snapshot): Account | undefined {
  const live = activeAccounts(snap.accounts)
  const aliases = new Map<string, string>()
  const exact = extractAccount(words, live)
  if (exact) return live.find((a) => a.id === exact.id)
  const fuzzy = fuzzyAccount(words, { accounts: live, categories: [] }, aliases)
  if (fuzzy && !('ambiguous' in fuzzy)) return live.find((a) => a.id === fuzzy.id)
  if (words.some((w) => /^(налич|нал$|кэш|кеш|cash)/.test(w))) return live.find((a) => accountKey(a.name).startsWith('nalichn'))
  return undefined
}

function usdOf(snap: Snapshot, amount: number, currency: string, date: string) {
  const r = usdRate(snap.rates, currency, date)
  return { rate_usd: r ? r.rate : 0, amount_usd: r ? round2(amount * r.rate) : 0, rate_pending: !r || !r.exact }
}

function baseTx(ctx: Ctx, over: Partial<Transaction>): Transaction {
  return {
    id: ctx.uuid(), deleted: false, kind: 'transfer', amount: 0, currency: 'USD', rate_usd: 1, amount_usd: 0, rate_pending: false,
    account_id: '', to_account_id: null, to_amount: null, to_currency: null, category_id: null, date: ctx.today, note: '',
    source: 'bot', created_at: ctx.now.toISOString(), author: ctx.author, archived: false, deleted_at: null, deleted_batch: null,
    ...over,
  }
}

const undoKb = (id: string) => [[{ text: 'Отменить', callback_data: `u:${id}` }]]

export const TRANSFER_RE = /^(перев[её]л|перевела|перевод|перевести|перекинул|перекинула|снял|сняла|снять)\s/
export const EXCHANGE_RE = /^(поменял|поменяла|обменял|обменяла|обмен|разменял|разменяла)\s/

/** «перевёл 200$ с основного на наличные», «перевод 500 грн на прокредит», «снял в банкомате 1000 гривен». */
export async function transfer(ctx: Ctx, text: string): Promise<BotReply[]> {
  if (!isMulti(ctx.settings)) return [send(ctx, SINGLE_MODE)]
  const snap = await load(ctx)
  const tokens = normalize(text).split(' ')
  const [m] = amounts(tokens, ctx)
  if (!m) return [send(ctx, 'Сколько перевести? Например: перевёл 200$ с основного на наличные')]
  const after = (word: string[]) => {
    const i = tokens.findIndex((t) => word.includes(t))
    return i < 0 ? [] : tokens.slice(i + 1, i + 3).filter((w) => !/\d/.test(w))
  }
  const withdraw = /^сн/.test(tokens[0])
  const fromWords = after(['с', 'со', 'из'])
  const toWords = after(['на', 'в'])
  let from = fromWords.length ? accountIn(fromWords.slice(0, 1), snap) ?? accountIn(fromWords, snap) : undefined
  let to = toWords.length ? accountIn(toWords.slice(0, 1), snap) ?? accountIn(toWords, snap) : undefined
  if (withdraw) {
    to = accountIn(['наличные'], snap)
    if (!to) return [send(ctx, 'Нет счёта «Наличные» — создай его: «создай счёт Наличные»')]
  }
  from ??= defaultAccount(snap.accounts)
  if (!from || !to) return [send(ctx, 'Не понял, на какой счёт. Например: перевод 500 грн на прокредит')]
  if (from.id === to.id) return [send(ctx, 'Счёт «откуда» и «куда» один и тот же')]
  const tx = baseTx(ctx, { kind: 'transfer', amount: m.value, currency: m.currency, account_id: from.id, to_account_id: to.id, ...usdOf(snap, m.value, m.currency, ctx.today) })
  await ctx.store.insertTx(tx)
  const line = `🔁 ${from.name} → ${to.name} · ${money(m.value, m.currency)}`
  return [send(ctx, line, undoKb(tx.id)), ...toOwner(ctx, `${partnerName(ctx.settings)}: ${line}`)]
}

/** NBU: UAH per unit of `a` over UAH per unit of `b` (how many b for one a). */
function nbuCross(snap: Snapshot, a: string, b: string, date: string): number | null {
  const ra = usdRate(snap.rates, a, date)
  const rb = usdRate(snap.rates, b, date)
  return ra && rb ? ra.rate / rb.rate : null
}

/** «поменял 100$ на 4100 грн», «обменял 4500 гривен на 100 долларов», «обмен 100 eur → 2000 лей». */
export async function exchange(ctx: Ctx, text: string): Promise<BotReply[]> {
  const snap = await load(ctx)
  const tokens = normalize(text.replace(/→|->/g, ' на ')).split(' ')
  const ms = amounts(tokens, ctx)
  if (ms.length < 2) return [send(ctx, 'Напиши обе суммы: поменял 100$ на 4100 грн')]
  const [give, get] = ms
  if (give.currency === get.currency) return [send(ctx, 'Валюты одинаковые — это не обмен')]
  const words = tokens.filter((_, i) => !ms.some((m) => i >= m.at && i < m.at + m.length))
  const account = (isMulti(ctx.settings) ? accountIn(words.slice(1).filter((w) => !['на', 'с', 'со'].includes(w)), snap) : undefined) ?? defaultAccount(snap.accounts)
  if (!account) return [send(ctx, 'Нет счёта — открой приложение')]
  const tx = baseTx(ctx, {
    kind: 'exchange', amount: give.value, currency: give.currency, account_id: account.id, to_amount: get.value,
    to_currency: get.currency, ...usdOf(snap, give.value, give.currency, ctx.today),
  })
  await ctx.store.insertTx(tx)
  // the rate is shown as «local per foreign»: UAH per $; between two foreign currencies — get per give
  const [unit, local] = get.currency === 'UAH' || (give.currency !== 'UAH' && get.value >= give.value) ? [give, get] : [get, give]
  const rate = local.value / unit.value
  const nbu = nbuCross(snap, unit.currency, local.currency, ctx.today)
  const nbuText = nbu ? ` (НБУ ${nbu.toFixed(2)})` : ''
  const line = `💱 ${money(give.value, give.currency)} → ${money(get.value, get.currency)} · курс ${rate.toFixed(2)}${nbuText}`
  return [send(ctx, line, undoKb(tx.id)), ...toOwner(ctx, `${partnerName(ctx.settings)}: ${line}`)]
}

export const RECONCILE_RE = /^(на руках|в наличных|наличными|на сч[её]те|на карте|на)\s/

/** Parse «на руках 3500$» / «на прокредите 8000 грн»: account + said amount, or null when it is not such a phrase. */
function reconcileParse(ctx: Ctx, snap: Snapshot, text: string): { account: Account; said: Money } | null {
  const tokens = normalize(text).split(' ')
  const ms = amounts(tokens, ctx)
  if (ms.length !== 1) return null
  const words = tokens.slice(0, ms[0].at).filter((w) => !['на', 'в', 'сч'].includes(w))
  if (ms[0].at + ms[0].length < tokens.length) return null // words after the amount: an ordinary record
  const hands = /^(на руках|в наличных|наличными)/.test(tokens.join(' '))
  let account: Account | undefined
  if (hands) account = (isMulti(ctx.settings) ? accountIn(['наличные'], snap) : undefined) ?? defaultAccount(snap.accounts)
  else if (/^на (сч[её]те|карте)/.test(tokens.join(' '))) account = defaultAccount(snap.accounts)
  else if (isMulti(ctx.settings)) account = accountIn(words, snap)
  if (!account) return null
  return { account, said: ms[0] }
}

export async function reconcile(ctx: Ctx, text: string, confirmed: boolean): Promise<BotReply[] | null> {
  const snap = await load(ctx)
  const p = reconcileParse(ctx, snap, text)
  if (!p) return null
  const bal = isMulti(ctx.settings) ? balances(snap.txs, p.account.id) : activeBalances(snap.txs, snap.accounts)
  const expected = round2(bal[p.said.currency] ?? 0)
  const diff = round2(p.said.value - expected)
  if (diff === 0) return [send(ctx, `Всё сходится: ${money(expected, p.said.currency)}`)]
  const signed = `${diff > 0 ? '+' : ''}${money(diff, p.said.currency)}`
  if (!confirmed) {
    const where = isMulti(ctx.settings) ? ` на «${p.account.name}»` : ''
    return [send(ctx, `Должно быть ${money(expected, p.said.currency)}${where}, ты говоришь ${money(p.said.value, p.said.currency)} — записать корректировку ${signed}?`,
      [[{ text: 'Сохранить', callback_data: 'ok' }, { text: 'Отмена', callback_data: 'no' }]], { replyTo: ctx.messageId })]
  }
  const tx = baseTx(ctx, {
    kind: 'adjustment', amount: diff, currency: p.said.currency, account_id: p.account.id, note: 'Сверка',
    ...usdOf(snap, diff, p.said.currency, ctx.today),
  })
  await ctx.store.insertTx(tx)
  return [send(ctx, `Записал корректировку ${signed}`, undoKb(tx.id)), ...toOwner(ctx, `${partnerName(ctx.settings)}: корректировка ${signed}`)]
}

const TARGET: Record<string, string> = {
  'гривнах': 'UAH', 'гривны': 'UAH', 'гривни': 'UAH', 'грн': 'UAH', 'гривне': 'UAH', 'долларах': 'USD', 'доллары': 'USD',
  'баксах': 'USD', 'usd': 'USD', '$': 'USD', 'евро': 'EUR', 'eur': 'EUR', 'леях': 'MDL', 'леи': 'MDL', 'лей': 'MDL', 'mdl': 'MDL',
}
const RATE_OF: Record<string, string> = { 'доллара': 'USD', 'долара': 'USD', 'евро': 'EUR', 'лея': 'MDL', 'леев': 'MDL', 'usd': 'USD', 'eur': 'EUR', 'mdl': 'MDL' }
export const RATE_RE = /^курс( (доллара|долара|евро|лея|леев|usd|eur|mdl|[a-z]{3}))?( нбу)?$/
export const CONVERT_RE = /^(сколько )?(.+) в (гривнах|гривны|гривни|грн|гривне|долларах|доллары|баксах|usd|\$|евро|eur|леях|леи|лей|mdl)$/

/** «курс», «курс доллара»: NBU rates for today (nothing is written). */
export async function rate(ctx: Ctx, text: string): Promise<BotReply[]> {
  const snap = await load(ctx)
  const m = RATE_RE.exec(normalize(text))
  const word = m?.[2]
  const list = word ? [RATE_OF[word] ?? word.toUpperCase()] : ctx.settings.currencies.filter((c) => c !== 'UAH')
  const lines = list.map((c) => {
    const r = nbuCross(snap, c, 'UAH', ctx.today)
    return r ? `${money(1, c)} = ${money(round2(r), 'UAH')}` : `${c}: курса нет`
  })
  return [send(ctx, `Курс НБУ на ${dayMonth(ctx.today)}:\n${lines.join('\n')}`)]
}

/** «сколько 100 евро в гривнах», «2000 лей в долларах». */
export async function convert(ctx: Ctx, text: string): Promise<BotReply[] | null> {
  const m = CONVERT_RE.exec(normalize(text))
  if (!m) return null
  const [a] = amounts(m[2].split(' '), ctx)
  if (!a) return null
  const target = TARGET[m[3]]
  const snap = await load(ctx)
  const r = nbuCross(snap, a.currency, target, ctx.today)
  if (!r) return [send(ctx, 'Нет курса для этой валюты')]
  return [send(ctx, `${money(a.value, a.currency)} = ${money(round2(a.value * r), target)} (курс НБУ на ${dayMonth(ctx.today)})`)]
}

export { usd }
