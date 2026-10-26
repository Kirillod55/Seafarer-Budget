// Groups 4, 5 and 7 of spec §5 and /settings. Everything that changes settings, goals, limits or accounts
// first shows what changes and waits for «Сохранить» (the button re-reads the source text), then offers
// «Отменить». The daily summary and /settings buttons change at once.
import { balances } from '../calc.ts'
import { dailyBudget, reservedUsd, reservingGoalMoves } from '../calc.ts'
import { addDays } from '../dates.ts'
import { CURRENCY_SYMBOL } from '../defaults.ts'
import { money } from '../format.ts'
import { round2, usdRate } from '../fx.ts'
import { accountKey } from '../fuzzy.ts'
import { aliasMap, amountAt, extractAccount, fuzzyAccount, fuzzyCurrency, matchCategory, matchDictionary, normalize, stripPunct } from '../parser.ts'
import type { Account, Goal, Limit, Settings } from '../types.ts'
import { answer, edit } from './callbacks.ts'
import type { Query } from './callbacks.ts'
import { activeAccounts, byShort, dayMonth, defaultAccount, isMulti, load, partnerName, send, short, toOwner, usd, usdWhole } from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import { restorePatch } from './types.ts'
import type { BotReply } from './types.ts'

const SAVE: Keyboard = [[{ text: 'Сохранить', callback_data: 'ok' }, { text: 'Отмена', callback_data: 'no' }]]
const ask = (ctx: Ctx, text: string): BotReply[] => [send(ctx, text, SAVE, { replyTo: ctx.messageId })]
const done = (ctx: Ctx, text: string, undo: string): BotReply[] => [send(ctx, text, [[{ text: 'Отменить', callback_data: undo }]])]

const MONTHS: Record<string, number> = {
  'января': 1, 'январю': 1, 'январь': 1, 'февраля': 2, 'февралю': 2, 'март': 3, 'марта': 3, 'марту': 3, 'апреля': 4, 'апрелю': 4,
  'мая': 5, 'маю': 5, 'июня': 6, 'июню': 6, 'июля': 7, 'июлю': 7, 'августа': 8, 'августу': 8, 'сентября': 9, 'сентябрю': 9,
  'октября': 10, 'октябрю': 10, 'ноября': 11, 'ноябрю': 11, 'декабря': 12, 'декабрю': 12,
}
const pad = (n: number) => String(n).padStart(2, '0')
function lastDay(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** A future date: «20 декабря», «20.12», «20.12.2026» (this year, or next when already past). */
export function futureDate(words: string[], today: string): string | null {
  const y0 = Number(today.slice(0, 4))
  for (let i = 0; i < words.length; i++) {
    const w = stripPunct(words[i])
    let d = 0, m = 0, y = 0
    const dm = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/.exec(w)
    if (dm) [d, m, y] = [Number(dm[1]), Number(dm[2]), dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : 0]
    else if (/^\d{1,2}$/.test(w) && MONTHS[stripPunct(words[i + 1] ?? '')]) {
      d = Number(w)
      m = MONTHS[stripPunct(words[i + 1])]
      const yy = stripPunct(words[i + 2] ?? '')
      if (/^\d{4}$/.test(yy)) y = Number(yy)
    } else continue
    if (m < 1 || m > 12 || d < 1 || d > lastDay(y || y0, m)) return null
    let date = `${y || y0}-${pad(m)}-${pad(d)}`
    if (!y && date < today) date = `${y0 + 1}-${pad(m)}-${pad(d)}`
    return date
  }
  return null
}

/** «к июню» / «к августу 2028»: the last day of that month (this year or the next). */
function deadline(words: string[], today: string): string | null {
  const i = words.findIndex((w) => w === 'к' || w === 'до')
  if (i < 0) return null
  const m = MONTHS[stripPunct(words[i + 1] ?? '')]
  if (!m) return futureDate(words.slice(i + 1), today)
  const yy = stripPunct(words[i + 2] ?? '')
  let y = /^\d{4}$/.test(yy) ? Number(yy) : Number(today.slice(0, 4))
  let date = `${y}-${pad(m)}-${pad(lastDay(y, m))}`
  if (date < today) {
    y++
    date = `${y}-${pad(m)}-${pad(lastDay(y, m))}`
  }
  return date
}

function firstAmount(ctx: Ctx, tokens: string[]): { value: number; currency: string; at: number; length: number } | null {
  const aliases = aliasMap(ctx.settings.currencies)
  for (let i = 0; i < tokens.length; i++) {
    const a = amountAt(tokens, i, aliases)
    if (!a) continue
    let currency = a.currency
    let length = a.length
    const f = !currency && tokens[i + length] ? fuzzyCurrency(tokens[i + length], aliases) : null
    if (f) {
      currency = f.code
      length++
    }
    return { value: a.value, currency: currency ?? ctx.settings.default_currency, at: i, length }
  }
  return null
}

const toUsd = (snap: Snapshot, value: number, currency: string, today: string) => {
  const r = usdRate(snap.rates, currency, today)
  return r ? round2(value * r.rate) : null
}

function perDay(ctx: Ctx, snap: Snapshot, s: Pick<Settings, 'next_contract_date' | 'reserve_usd'>): string {
  const b = dailyBudget({ txs: snap.txs, rates: snap.rates, accounts: snap.accounts, reservedUsd: reservedUsd(reservingGoalMoves(snap.moves, snap.goals)), settings: s, today: ctx.today })
  return b.state === 'no_date' ? 'без даты' : b.state === 'sea' ? 'дата прошла' : `${usd(b.perDay)} в день`
}

async function setSettings(ctx: Ctx, patch: Partial<Settings>) {
  await ctx.store.update('settings', ctx.settings.id, patch)
  Object.assign(ctx.settings, patch)
}

const CUR_WORDS: Record<string, string> = {
  'гривны': 'UAH', 'гривна': 'UAH', 'грн': 'UAH', 'гривни': 'UAH', 'доллары': 'USD', 'доллар': 'USD', 'usd': 'USD', 'евро': 'EUR',
  'eur': 'EUR', 'леи': 'MDL', 'лей': 'MDL', 'mdl': 'MDL',
}
/** Currencies the NBU publishes (enough to check «добавь валюту PLN»). */
const NBU_CODES = new Set(['USD', 'EUR', 'MDL', 'PLN', 'GBP', 'CHF', 'CZK', 'TRY', 'GEL', 'RON', 'HUF', 'SEK', 'NOK', 'DKK', 'CAD', 'AUD', 'JPY', 'CNY', 'BGN', 'ILS', 'AED', 'EGP', 'SGD', 'KZT', 'INR', 'KRW', 'MXN', 'NZD', 'HKD', 'THB', 'AZN', 'RSD', 'IDR', 'VND', 'BDT', 'DZD', 'LBP', 'MYR', 'SAR', 'TND', 'ZAR', 'CNY', 'XAU'])

export const PREF_RE = /^(посадка|дата посадки|запас|по умолчанию|валюта по умолчанию|добавь валюту|создай сч[её]т|добавь сч[её]т|новый сч[её]т|напоминай|выключи напоминания|не напоминай|новая цель|создай цель|лимит на|убери лимит|удали лимит|цель .+ к \S+)/

/** The settings phrases (groups 4–5). Returns null when the text is not one. */
export async function prefPhrase(ctx: Ctx, text: string, confirmed: boolean): Promise<BotReply[] | null> {
  const t = normalize(text)
  if (!PREF_RE.test(t)) return null
  const words = t.split(' ')
  const snap = await load(ctx)
  const s = ctx.settings

  if (/^(посадка|дата посадки)/.test(t)) {
    const date = futureDate(words, ctx.today)
    if (!date) return [send(ctx, 'Напиши дату: «посадка 20 декабря» или «посадка 20.12»')]
    if (!confirmed) return ask(ctx, `Посадка ${dayMonth(date)} ${date.slice(0, 4)}: было ${perDay(ctx, snap, s)} → станет ${perDay(ctx, snap, { ...s, next_contract_date: date })}`)
    const old = s.next_contract_date ?? '-'
    await setSettings(ctx, { next_contract_date: date })
    return done(ctx, `Сохранил: посадка ${dayMonth(date)}`, `us:l:${old}`)
  }
  if (/^запас/.test(t)) {
    const a = firstAmount(ctx, words)
    if (!a) return [send(ctx, 'Сколько оставить к посадке? Например: запас 1000$')]
    const value = toUsd(snap, a.value, a.currency, ctx.today)
    if (value === null) return [send(ctx, 'Нет курса для этой валюты')]
    if (!confirmed) return ask(ctx, `Запас к посадке ${usdWhole(value)}: было ${perDay(ctx, snap, s)} → станет ${perDay(ctx, snap, { ...s, reserve_usd: value })}`)
    const old = s.reserve_usd
    await setSettings(ctx, { reserve_usd: value })
    return done(ctx, `Сохранил: запас ${usdWhole(value)}`, `us:r:${old}`)
  }
  if (/^(по умолчанию|валюта по умолчанию)/.test(t)) {
    const code = words.map((w) => CUR_WORDS[stripPunct(w)] ?? aliasMap(s.currencies).get(stripPunct(w))).find(Boolean)
    if (!code || !s.currencies.includes(code)) return [send(ctx, `Валюты: ${s.currencies.join(', ')}. Например: по умолчанию леи`)]
    if (!confirmed) return ask(ctx, `Валюта по умолчанию: ${s.default_currency} → ${code}`)
    const old = s.default_currency
    await setSettings(ctx, { default_currency: code })
    return done(ctx, `Сохранил: по умолчанию ${code}`, `us:c:${old}`)
  }
  if (/^добавь валюту/.test(t)) {
    const code = (words[2] ?? '').toUpperCase()
    if (!/^[A-Z]{3}$/.test(code) || !NBU_CODES.has(code)) return [send(ctx, `НБУ не знает валюту «${words[2] ?? ''}» — напиши трёхбуквенный код, например PLN`)]
    if (s.currencies.includes(code)) return [send(ctx, `${code} уже есть`)]
    if (!confirmed) return ask(ctx, `Добавить валюту ${code}? Валюты станут: ${[...s.currencies, code].join(', ')}`)
    await setSettings(ctx, { currencies: [...s.currencies, code] })
    return done(ctx, `Добавил ${code}`, `us:a:${code}`)
  }
  if (/^(создай|добавь|новый) сч[её]т/.test(t)) {
    if (!isMulti(s)) return [send(ctx, 'Счета — в режиме «Несколько счетов» (включается в приложении)')]
    const raw = text.trim().split(/\s+/).slice(2).join(' ').replace(/["«»]/g, '').trim().slice(0, 30)
    if (!raw) return [send(ctx, 'Как назвать счёт? Например: создай счёт Монобанк')]
    const name = raw[0].toUpperCase() + raw.slice(1)
    if (snap.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) return [send(ctx, `Счёт «${name}» уже есть`)]
    if (!confirmed) return ask(ctx, `Создать счёт «${name}»?`)
    const acc: Account = { id: ctx.uuid(), deleted: false, name, aliases: [], is_default: false, archived: false, sort: Math.max(0, ...snap.accounts.map((a) => a.sort)) + 1 }
    await ctx.store.insert('accounts', acc)
    return done(ctx, `Создал счёт «${name}»`, `uac:${short(acc.id)}`)
  }
  if (/^(напоминай|выключи напоминания|не напоминай)/.test(t)) {
    const n = /^напоминай/.test(t) ? Number(words.find((w) => /^\d+$/.test(w)) ?? NaN) : 0
    if (![0, 2, 3, 5, 7].includes(n)) return [send(ctx, 'Можно через 2, 3, 5 или 7 дней, или «выключи напоминания»')]
    const label = n ? `через ${n} дн без записей` : 'выключены'
    if (!confirmed) return ask(ctx, `Напоминания: ${label}`)
    const old = s.remind_after_days
    await setSettings(ctx, { remind_after_days: n as Settings['remind_after_days'] })
    return done(ctx, `Сохранил: напоминания ${label}`, `us:m:${old}`)
  }
  if (/^(новая цель|создай цель|цель .+ к \S+)/.test(t)) {
    const body = words.slice(words[0] === 'цель' ? 1 : 2)
    const a = firstAmount(ctx, body)
    if (!a) return [send(ctx, 'Сколько нужно? Например: новая цель отпуск 2000$ к июню')]
    const name = body.slice(0, a.at).join(' ').trim()
    if (!name) return [send(ctx, 'Как назвать цель? Например: новая цель отпуск 2000$ к июню')]
    const target = toUsd(snap, a.value, a.currency, ctx.today)
    if (target === null) return [send(ctx, 'Нет курса для этой валюты')]
    const dl = deadline(body.slice(a.at + a.length), ctx.today)
    const title = name[0].toUpperCase() + name.slice(1)
    const when = dl ? ` к ${dayMonth(dl)} ${dl.slice(0, 4)}` : ''
    if (!confirmed) return ask(ctx, `Новая цель «${title}»: ${usdWhole(target)}${when}`)
    const goal: Goal = { id: ctx.uuid(), deleted: false, deleted_at: null, deleted_batch: null, name: title, target_usd: target, deadline: dl, archived: false }
    await ctx.store.insert('goals', goal)
    return [...done(ctx, `🎯 Создал цель «${title}»: ${usdWhole(target)}${when}`, `ugl:${short(goal.id)}`), ...toOwner(ctx, `${partnerName(s)} создала цель «${title}»`)]
  }
  if (/^лимит на/.test(t)) {
    const a = firstAmount(ctx, words)
    const catWords = words.slice(2, a ? a.at : undefined)
    const cat = matchCategory(catWords, snap.categories, 'expense') ?? matchDictionary(catWords, snap.categories, 'expense')
    if (!a || !cat) return [send(ctx, 'Например: лимит на кафе 150$')]
    const value = toUsd(snap, a.value, a.currency, ctx.today)
    if (value === null) return [send(ctx, 'Нет курса для этой валюты')]
    const old = snap.limits.find((l) => l.category_id === cat.id)
    if (!confirmed) return ask(ctx, `Лимит на «${cat.name}»: ${usdWhole(value)} в месяц${old ? ` (было ${usdWhole(old.monthly_usd)})` : ''}`)
    if (old) {
      await ctx.store.update('limits', old.id, { monthly_usd: value })
      return done(ctx, `Сохранил лимит «${cat.name}»: ${usdWhole(value)}`, `ul:${short(old.id)}:${old.monthly_usd}`)
    }
    const limit: Limit = { id: ctx.uuid(), deleted: false, deleted_at: null, deleted_batch: null, category_id: cat.id, monthly_usd: value }
    await ctx.store.insert('limits', limit)
    return done(ctx, `Сохранил лимит «${cat.name}»: ${usdWhole(value)}`, `ul:${short(limit.id)}:-`)
  }
  if (/^(убери|удали) лимит/.test(t)) {
    const catWords = words.slice(2).filter((w) => w !== 'на')
    const cat = matchCategory(catWords, snap.categories, 'expense') ?? matchDictionary(catWords, snap.categories, 'expense')
    const limit = cat && snap.limits.find((l) => l.category_id === cat.id)
    if (!cat || !limit) return [send(ctx, 'Такого лимита нет — посмотри /limits')]
    if (!confirmed) return ask(ctx, `Убрать лимит на «${cat.name}» (${usdWhole(limit.monthly_usd)})?`)
    await ctx.store.update('limits', limit.id, { deleted_at: ctx.now.toISOString(), deleted_batch: ctx.uuid() })
    return done(ctx, `Убрал лимит на «${cat.name}»`, `ulr:${short(limit.id)}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// accounts: «удали счёт Монобанк», «закрой счёт прокредит», «убери счёт … в архив»
// ---------------------------------------------------------------------------
export const ACCOUNT_DELETE_RE = /^(удали|закрой|убери|архивируй)\s+сч[её]т(?![\p{L}\d])/u

function findAccount(words: string[], snap: Snapshot): Account | undefined {
  const live = activeAccounts(snap.accounts)
  const exact = extractAccount(words, live)
  if (exact) return live.find((a) => a.id === exact.id)
  const f = fuzzyAccount(words, { accounts: live, categories: [] }, new Map())
  if (f && !('ambiguous' in f)) return live.find((a) => a.id === f.id)
  return live.find((a) => words.some((w) => w.length >= 4 && accountKey(a.name).startsWith(accountKey(w))))
}

export async function accountDelete(ctx: Ctx, text: string): Promise<BotReply[]> {
  if (!isMulti(ctx.settings)) return [send(ctx, 'Счета — в режиме «Несколько счетов» (включается в приложении)')]
  const snap = await load(ctx)
  const words = normalize(text).split(' ').slice(2).filter((w) => !['в', 'архив'].includes(w))
  const acc = findAccount(words, snap)
  if (!acc) return [send(ctx, 'Не нашёл такой счёт')]
  if (acc.id === defaultAccount(snap.accounts)?.id) return [send(ctx, 'Сначала сделай основным другой счёт в приложении')]
  const bal = Object.entries(balances(snap.txs, acc.id)).filter(([, v]) => Math.abs(v) >= 0.005)
  const id = short(acc.id)
  if (bal.length === 0) {
    return [send(ctx, `Удалить счёт «${acc.name}»? Старые записи сохранятся, счёт пропадёт из списков. Удаление окончательное, «В архив» можно вернуть`, [
      [{ text: 'Удалить', callback_data: `acd:${id}` }, { text: 'В архив', callback_data: `aca:${id}` }, { text: 'Отмена', callback_data: 'no' }],
    ])]
  }
  const usdTotal = bal.reduce((s, [c, v]) => s + (toUsd(snap, v, c, ctx.today) ?? 0), 0)
  const main = defaultAccount(snap.accounts)!
  return [send(ctx, `На счёте «${acc.name}» ${bal.map(([c, v]) => money(v, c)).join(' + ')} (≈ ${usdWhole(usdTotal)}). Что сделать?`, [
    [{ text: `Перевести на «${main.name}» и удалить`, callback_data: `act:${id}` }],
    [{ text: 'Только в архив', callback_data: `aca:${id}` }, { text: 'Отмена', callback_data: 'no' }],
  ])]
}

// ---------------------------------------------------------------------------
// daily summary (per writer) and /settings
// ---------------------------------------------------------------------------
export const SUMMARY_RE = /^(присылай|включи|выключи|не присылай|отключи) итог дня/

export async function summaryToggle(ctx: Ctx, text: string): Promise<BotReply[]> {
  const on = /^(присылай|включи)/.test(normalize(text))
  const field = ctx.author === 'owner' ? 'daily_summary_owner' : 'daily_summary_partner'
  await setSettings(ctx, { [field]: on } as Partial<Settings>)
  return [send(ctx, on ? '🔔 Итог дня включён — пришлю вечером' : '🔕 Итог дня выключен')]
}

function settingsView(ctx: Ctx): { text: string; kb: Keyboard } {
  const s = ctx.settings
  const mine = ctx.author === 'owner' ? s.daily_summary_owner : s.daily_summary_partner
  const mark = (on: boolean, label: string) => (on ? `✓ ${label}` : label)
  const kb: Keyboard = [
    [{ text: mine ? 'Итог дня: 🔔 Вкл' : 'Итог дня: 🔕 Выкл', callback_data: 'st:s' }],
    [0, 2, 3, 5, 7].map((n) => ({ text: mark(s.remind_after_days === n, n ? `${n} дн.` : 'Выкл'), callback_data: `st:r:${n}` })),
    s.currencies.slice(0, 6).map((c) => ({ text: mark(s.default_currency === c, CURRENCY_SYMBOL[c] ?? (c === 'MDL' ? 'L' : c)), callback_data: `st:c:${c}` })),
    [{ text: 'Готово', callback_data: 'st:d' }],
  ]
  const text = [
    '⚙️ Настройки бота',
    `Итог дня (твой): ${mine ? '🔔 Вкл' : '🔕 Выкл'}`,
    `Напоминание без записей: ${s.remind_after_days ? `${s.remind_after_days} дн.` : 'Выкл'}`,
    `Валюта по умолчанию: ${s.default_currency}`,
  ].join('\n')
  return { text, kb }
}

export function settingsMenu(ctx: Ctx): BotReply[] {
  const v = settingsView(ctx)
  return [send(ctx, v.text, v.kb)]
}

/** Callbacks: ok/no (confirmations are handled by the router), st:*, us:*, uac, ugl, ul, ulr, acd/aca/act, uaa. */
export async function prefCallback(ctx: Ctx, q: Query, data: string): Promise<BotReply[] | null> {
  const [kind, a, b] = data.split(':')
  const s = ctx.settings
  if (kind === 'st') {
    if (a === 'd') return [answer(q), edit(ctx, q, 'Готово')]
    if (a === 's') {
      const field = ctx.author === 'owner' ? 'daily_summary_owner' : 'daily_summary_partner'
      await setSettings(ctx, { [field]: !s[field] } as Partial<Settings>)
    }
    if (a === 'r' && [0, 2, 3, 5, 7].includes(Number(b))) await setSettings(ctx, { remind_after_days: Number(b) as Settings['remind_after_days'] })
    if (a === 'c' && s.currencies.includes(b)) await setSettings(ctx, { default_currency: b })
    const v = settingsView(ctx)
    return [answer(q, 'Сохранил'), edit(ctx, q, v.text, v.kb)]
  }
  if (kind === 'us') {
    const old = data.slice(5)
    if (a === 'l') await setSettings(ctx, { next_contract_date: old === '-' ? null : old })
    else if (a === 'r') await setSettings(ctx, { reserve_usd: Number(old) })
    else if (a === 'c') await setSettings(ctx, { default_currency: old })
    else if (a === 'a') await setSettings(ctx, { currencies: s.currencies.filter((c) => c !== old) })
    else if (a === 'm') await setSettings(ctx, { remind_after_days: Number(old) as Settings['remind_after_days'] })
    return [answer(q, 'Отменено'), edit(ctx, q, 'Отменено — как было')]
  }
  if (!['uac', 'ugl', 'ul', 'ulr', 'acd', 'aca', 'act', 'uaa'].includes(kind)) return null
  const snap = await load(ctx)
  if (kind === 'ugl') {
    const g = byShort(snap.goals, a)
    if (!g) return [answer(q, 'Уже отменено')]
    if (snap.moves.some((m) => m.goal_id === g.id)) return [answer(q, 'В цели уже есть деньги — удали её в приложении')]
    await ctx.store.update('goals', g.id, { deleted: true })
    return [answer(q, 'Отменено'), edit(ctx, q, `Отменено: цель «${g.name}» удалена`)]
  }
  if (kind === 'ul') {
    const l = byShort(snap.limits, a)
    if (!l) return [answer(q, 'Уже отменено')]
    if (b === '-') await ctx.store.update('limits', l.id, { deleted: true })
    else await ctx.store.update('limits', l.id, { monthly_usd: Number(b) })
    return [answer(q, 'Отменено'), edit(ctx, q, 'Отменено — лимит как был')]
  }
  if (kind === 'ulr') {
    const l = byShort(await ctx.store.limits(), a)
    if (!l) return [answer(q, 'Уже нельзя вернуть')]
    await ctx.store.update('limits', l.id, restorePatch(l))
    return [answer(q, 'Отменено'), edit(ctx, q, 'Вернул лимит')]
  }
  const acc = byShort(snap.accounts, a)
  if (!acc) return [answer(q, 'Счёт не найден')]
  const who = partnerName(s)
  if (kind === 'uac') {
    if (snap.txs.some((t) => t.account_id === acc.id || t.to_account_id === acc.id)) return [answer(q, 'На счёте уже есть записи — удали его в приложении')]
    await ctx.store.update('accounts', acc.id, { deleted: true })
    return [answer(q, 'Отменено'), edit(ctx, q, `Отменено: счёт «${acc.name}» удалён`)]
  }
  if (kind === 'uaa') {
    await ctx.store.update('accounts', acc.id, { archived: false })
    return [answer(q, 'Отменено'), edit(ctx, q, `Вернул счёт «${acc.name}»`)]
  }
  if (kind === 'aca') {
    await ctx.store.update('accounts', acc.id, { archived: true })
    return [answer(q, 'Готово'), edit(ctx, q, `Счёт «${acc.name}» в архиве`, [[{ text: 'Отменить', callback_data: `uaa:${a}` }]]), ...toOwner(ctx, `${who} убрала в архив счёт «${acc.name}»`)]
  }
  // acd / act: deleting an account is final (accounts have no 24 h bin)
  if (kind === 'act') {
    const main = defaultAccount(snap.accounts)!
    for (const [cur, v] of Object.entries(balances(snap.txs, acc.id))) {
      if (Math.abs(v) < 0.005) continue
      const r = usdRate(snap.rates, cur, ctx.today)
      await ctx.store.insertTx({
        // a positive rest moves to the main account; a debt is covered from it
        id: ctx.uuid(), deleted: false, kind: 'transfer', amount: Math.abs(v), currency: cur,
        rate_usd: r ? r.rate : 0, amount_usd: r ? round2(Math.abs(v) * r.rate) : 0, rate_pending: !r || !r.exact,
        account_id: v > 0 ? acc.id : main.id, to_account_id: v > 0 ? main.id : acc.id, to_amount: null, to_currency: null, category_id: null,
        date: ctx.today, note: `Остаток со счёта «${acc.name}»`, source: 'bot', created_at: ctx.now.toISOString(), author: ctx.author,
        archived: false, deleted_at: null, deleted_batch: null,
      })
    }
  }
  await ctx.store.update('accounts', acc.id, { deleted: true })
  return [answer(q, 'Удалено'), edit(ctx, q, `Удалил счёт «${acc.name}»${kind === 'act' ? `, остаток перевёл на «${main(snap).name}»` : ''}`), ...toOwner(ctx, `${who} удалила счёт «${acc.name}»`)]
}

const main = (snap: Snapshot) => defaultAccount(snap.accounts)!
export { addDays }
