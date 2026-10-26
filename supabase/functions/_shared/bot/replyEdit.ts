// Fixing a record by replying to the bot's message (spec §5 «Исправление ответом», group 6):
// «90», «90 eur», «аптека», «вчера», «удали», «наличные», «кафе»; «2 90» for the 2nd record of a list.
// The record is found by the ids in the replied message's buttons. Only the writer's own records.
import { usdRate, round2 } from '../fx.ts'
import { aliasMap, amountAt, dateOf, extractAccount, fuzzyAccount, fuzzyCurrency, matchCategory, matchDictionary, normalize, stripPunct } from '../parser.ts'
import type { Transaction } from '../types.ts'
import { amountText, activeCategories, describeTx, idsInKeyboard, isMulti, load, send } from './ctx.ts'
import type { Ctx } from './ctx.ts'
import { manyKeyboard, manyText, recordKeyboard, singleText } from './records.ts'
import type { BotReply } from './types.ts'

// deno-lint-ignore no-explicit-any
export async function replyEdit(ctx: Ctx, text: string, replied: any): Promise<BotReply[] | null> {
  const ids = idsInKeyboard(replied?.reply_markup)
  if (ids.length === 0) return null
  let tokens = normalize(text).split(' ').filter(Boolean)
  let index = 0
  if (ids.length > 1) {
    if (!/^\d{1,2}$/.test(tokens[0] ?? '') || Number(tokens[0]) < 1 || Number(tokens[0]) > ids.length || tokens.length < 2) {
      return [send(ctx, `Укажи номер записи впереди: «2 90», «2 вчера»`)]
    }
    index = Number(tokens[0]) - 1
    tokens = tokens.slice(1)
  }
  const snap = await load(ctx)
  const tx = snap.txs.find((t) => t.id === ids[index])
  if (!tx) return [send(ctx, 'Эта запись уже удалена')]
  if (tx.author !== ctx.author) return [send(ctx, 'Исправлять можно только свои записи')]

  const before = describeTx(tx, snap, ctx)
  const patch: Partial<Transaction> = {}
  const changes: string[] = []

  if (tokens.length === 1 && /^(удали|удалить|удалите)$/.test(tokens[0])) {
    const batch = ctx.uuid()
    await ctx.store.update('transactions', tx.id, { deleted_at: ctx.now.toISOString(), deleted_batch: batch })
    return [send(ctx, `Удалил: ${before}`, [[{ text: 'Вернуть', callback_data: `rs:${batch}` }]])]
  }

  const date = dateOf(tokens, ctx.today)
  if (date) {
    if (date > ctx.today) return [send(ctx, 'Не записываю в будущее — проверь дату')]
    patch.date = date
    changes.push(`дата → ${date === ctx.today ? 'сегодня' : date}`)
    tokens = []
  }

  const aliases = aliasMap(ctx.settings.currencies)
  for (let i = 0; i < tokens.length; i++) {
    const a = amountAt(tokens, i, aliases)
    if (!a) continue
    let currency = a.currency
    let len = a.length
    const f = !currency && tokens[i + len] ? fuzzyCurrency(tokens[i + len], aliases) : null
    if (f) {
      currency = f.code
      len++
    }
    patch.amount = a.value
    if (currency) patch.currency = currency
    tokens = [...tokens.slice(0, i), ...tokens.slice(i + len)]
    break
  }

  const words = tokens.map(stripPunct).filter(Boolean)
  if (words.length && isMulti(ctx.settings) && words.length <= 2) {
    const acc = extractAccount(words, snap.accounts) ?? fuzzyAccount(words, snap, aliases)
    if (acc && !('ambiguous' in acc) && acc.rest.length === 0) {
      patch.account_id = acc.id
      changes.push(`счёт → ${snap.accounts.find((x) => x.id === acc.id)?.name}`)
      words.length = 0
    }
  }
  if (words.length) {
    const kind = tx.kind === 'income' ? 'income' : 'expense'
    const cats = activeCategories(snap.categories, kind)
    const byName = words.length <= 2 ? cats.find((c) => c.name.toLowerCase().startsWith(words.join(' ').slice(0, 4)) && words.join(' ').length >= 4) : undefined
    if (byName) {
      patch.category_id = byName.id
      changes.push(`категория → ${byName.name}`)
    } else {
      patch.note = words.join(' ')
      const cat = matchCategory(words, snap.categories, kind) ?? matchDictionary(words, snap.categories, kind)
      if (cat) patch.category_id = cat.id
      changes.push(`заметка → «${patch.note}»`)
    }
  }

  if (patch.amount !== undefined || patch.currency !== undefined || patch.date !== undefined) {
    const amount = patch.amount ?? tx.amount
    const currency = patch.currency ?? tx.currency
    const r = usdRate(snap.rates, currency, patch.date ?? tx.date)
    Object.assign(patch, { rate_usd: r ? r.rate : 0, amount_usd: r ? round2(amount * r.rate) : 0, rate_pending: !r || !r.exact })
  }
  if (Object.keys(patch).length === 0) return [send(ctx, 'Не понял, что исправить: «90», «вчера», «наличные», «кафе» или «удали»')]

  await ctx.store.updateTx(tx.id, patch)
  const updated: Transaction = { ...tx, ...patch }
  snap.txs = snap.txs.map((t) => (t.id === tx.id ? updated : t))
  if (patch.amount !== undefined) changes.unshift(`${amountText(tx)} → ${amountText(updated)}`)

  const out: BotReply[] = []
  if (ids.length === 1) {
    out.push({ method: 'editMessageText', payload: { chat_id: ctx.chatId, message_id: replied.message_id, text: singleText(ctx, snap, updated), reply_markup: { inline_keyboard: recordKeyboard(ctx, snap, updated) } } })
  } else if (/^Записал \d+:/m.test(String(replied.text ?? ''))) {
    const txs = ids.map((id) => snap.txs.find((t) => t.id === id)).filter((t): t is Transaction => !!t)
    out.push({ method: 'editMessageText', payload: { chat_id: ctx.chatId, message_id: replied.message_id, text: manyText(ctx, snap, txs), reply_markup: { inline_keyboard: manyKeyboard(snap, txs) } } })
  }
  out.push(send(ctx, `Исправил: ${changes.join(', ')}`))
  return out
}
