// The bot's per-update context and small shared helpers (texts, buttons, record lines). No npm imports.
import { alive, liveRows } from '../alive.ts'
import { dailyBudget, reservedUsd, reservingGoalMoves } from '../calc.ts'
import { addDays } from '../dates.ts'
import { money } from '../format.ts'
import { round2, usdRate } from '../fx.ts'
import type { Account, Author, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from '../types.ts'
import type { BotReply, BotStore } from './types.ts'

export type Button = { text: string; callback_data: string }
export type Keyboard = Button[][]

export interface Ctx {
  chatId: number
  author: Author
  ownerChatId: number
  partnerChatId: number | null
  settings: Settings
  store: BotStore
  now: Date
  today: string
  uuid: () => string
  /** Groq key present: voice and the AI parser are on (stage 5) */
  groq: boolean
  /** the user's message being answered (questions are sent as a reply to it) */
  messageId?: number
}

export interface Snapshot {
  txs: Transaction[]
  categories: Category[]
  accounts: Account[]
  goals: Goal[]
  moves: GoalMove[]
  limits: Limit[]
  rates: FxRate[]
}

export async function load(ctx: Ctx): Promise<Snapshot> {
  const s = ctx.store
  const [txs, categories, accounts, goals, moves, limits, rates] = await Promise.all([
    s.transactions(), s.categories(), s.accounts(), s.goals(), s.goalMoves(), s.limits(), s.rates(),
  ])
  return {
    txs: liveRows(txs), categories: liveRows(categories), accounts: accounts.filter((a) => !a.deleted),
    goals: liveRows(goals), moves: moves.filter((m) => !m.deleted), limits: liveRows(limits), rates,
  }
}

export const usd = (n: number) => money(n, 'USD')
export const usdWhole = (n: number) => money(n, 'USD', { whole: true })

export function send(ctx: Ctx, text: string, keyboard?: Keyboard, opts: { replyTo?: number; html?: boolean } = {}): BotReply {
  const payload: Record<string, unknown> = { chat_id: ctx.chatId, text }
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard }
  if (opts.replyTo) payload.reply_to_message_id = opts.replyTo
  if (opts.html) payload.parse_mode = 'HTML'
  return { method: 'sendMessage', payload }
}

/** A message to Kirill about what Masha did (nothing when the owner writes). */
export function toOwner(ctx: Ctx, text: string): BotReply[] {
  if (ctx.author !== 'partner') return []
  return [{ method: 'sendMessage', payload: { chat_id: ctx.ownerChatId, text } }]
}

export const partnerName = (s: Settings) => s.partner_name?.trim() || 'Она'
export const isMulti = (s: Settings) => s.accounts_mode === 'multi'

export function activeAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.deleted && !a.archived).sort((a, b) => a.sort - b.sort)
}

export function defaultAccount(accounts: Account[]): Account | undefined {
  const live = activeAccounts(accounts)
  return live.find((a) => a.is_default) ?? live[0]
}

export function activeCategories(categories: Category[], kind?: 'expense' | 'income'): Category[] {
  return categories.filter((c) => alive(c) && !c.archived && (!kind || c.kind === kind)).sort((a, b) => a.sort - b.sort)
}

export const short = (id: string) => id.slice(0, 8)
export const byShort = <T extends { id: string }>(rows: T[], s: string) => rows.find((r) => r.id.startsWith(s))

const NO_CATEGORY = { icon: '❔', name: 'Без категории' }

export function categoryOf(t: Transaction, categories: Category[]): { icon: string; name: string } {
  const c = t.category_id ? categories.find((x) => x.id === t.category_id) : undefined
  return c ? { icon: c.icon, name: c.name } : NO_CATEGORY
}

/** `₴80 ($1.94)`; USD amounts do not repeat themselves; pending rate is marked. */
export function amountText(t: Pick<Transaction, 'amount' | 'currency' | 'amount_usd' | 'rate_pending' | 'kind'>): string {
  const base = `${t.kind === 'income' ? '+' : ''}${money(t.amount, t.currency)}`
  if (t.currency === 'USD') return base
  if (t.rate_pending && t.amount_usd === 0) return `${base} (курс уточнится)`
  return `${base} (${t.rate_pending ? '≈' : ''}${usd(t.amount_usd)})`
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

/** «21 октября» */
export const dayMonth = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS_GEN[Number(date.slice(5, 7)) - 1]}`
/** «октябрь» for 'YYYY-MM' */
export const monthName = (month: string) => MONTHS_NOM[Number(month.slice(5, 7)) - 1]
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** '' for today, else «вчера» / «позавчера» / «21 октября». */
export function dateWord(date: string, today: string): string {
  if (date === today) return ''
  if (date === addDays(today, -1)) return 'вчера'
  if (date === addDays(today, -2)) return 'позавчера'
  return dayMonth(date)
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
export const records = (n: number) => `${n} ${plural(n, 'запись', 'записи', 'записей')}`

/** `☕ Кафе и рестораны · ₴80 ($1.94) · Основной · вчера` (account only in «Несколько счетов»). */
export function describeTx(t: Transaction, snap: Pick<Snapshot, 'categories' | 'accounts'>, ctx: Ctx): string {
  const c = categoryOf(t, snap.categories)
  let line = `${c.icon} ${c.name} · ${amountText(t)}`
  if (isMulti(ctx.settings)) {
    const a = snap.accounts.find((x) => x.id === t.account_id)
    if (a) line += ` · ${a.name}`
  }
  const d = dateWord(t.date, ctx.today)
  if (d) line += ` · ${d}`
  return line
}

/** USD rate for a currency on a date; pending when only an earlier rate is known. */
export function rateFor(rates: FxRate[], currency: string, date: string) {
  const r = usdRate(rates, currency, date)
  if (!r) return { rate_usd: 0, rate_pending: true, toUsd: (_: number) => 0 }
  return { rate_usd: r.rate, rate_pending: !r.exact, toUsd: (a: number) => round2(a * r.rate) }
}

export function budgetOf(ctx: Ctx, snap: Snapshot) {
  return dailyBudget({
    txs: snap.txs, rates: snap.rates, accounts: snap.accounts, reservedUsd: reservedUsd(reservingGoalMoves(snap.moves, snap.goals)),
    settings: ctx.settings, today: ctx.today,
  })
}

/** «Сегодня осталось $X из $Y» / «Сегодня перерасход $X»; '' without a landing date or after it. */
export function todayLine(ctx: Ctx, snap: Snapshot): string {
  const b = budgetOf(ctx, snap)
  if (b.state === 'no_date' || b.state === 'sea') return ''
  if (b.leftToday < 0) return `Сегодня перерасход ${usd(-b.leftToday)}`
  return `Сегодня осталось ${usd(b.leftToday)} из ${usd(b.perDay)}`
}

/** Ids of records referenced by a bot message's buttons, in order of first appearance. */
export function idsInKeyboard(markup: unknown): string[] {
  // deno-lint-ignore no-explicit-any
  const rows = ((markup as any)?.inline_keyboard ?? []) as Button[][]
  const out: string[] = []
  for (const b of rows.flat()) {
    const m = /^(?:u|c|a|x):([0-9a-f-]{36})/.exec(b.callback_data ?? '')
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** The minute stamp carried by buttons that expire after 10 minutes. */
export const minuteOf = (now: Date) => Math.floor(now.getTime() / 60_000)
export const expired = (stamp: string | undefined, now: Date) => !stamp || minuteOf(now) - Number(stamp) > 10
