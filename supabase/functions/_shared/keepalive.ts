// The daily ping (spec §10): keeps the free Supabase project awake and does the server's chores.
// Pure: the database (service role!), Telegram and NBU sit behind KeepaliveDeps. Morning run (UTC < 12):
// keepalive_at, reminder, Sunday backup, webhook check, pending rates, final purge of the 24 h bin,
// bot_updates cleanup. Evening run: keepalive_at, reminder, the daily summary. No npm imports.
import { alive } from './alive.ts'
import { dailyBudget, reservedUsd, reservingGoalMoves } from './calc.ts'
import { toCsv } from './csv.ts'
import { addDays, localDate } from './dates.ts'
import { money } from './format.ts'
import { round2, usdRate } from './fx.ts'
import { purgeDue } from './wipe.ts'
import { SOFT_TABLES } from './types.ts'
import type { Account, Category, FxRate, Goal, GoalMove, Settings, SoftTable, Transaction } from './types.ts'

const DAY_MS = 86_400_000
const BOT_UPDATES_DAYS = 30
const MAX_RATE_DATES = 31
const QUEUE_LIMIT = 5

export interface WebhookInfo { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }

export interface KeepaliveDeps {
  settings(): Promise<Settings | null>
  /** must run as service_role: set_rev() keeps keepalive_at / last_reminder_at for anyone else */
  updateSettings(patch: Partial<Settings>): Promise<void>
  /** live transactions (not deleted, not in the bin) */
  transactions(): Promise<Transaction[]>
  goalMoves(): Promise<GoalMove[]>
  goals(): Promise<Goal[]>
  categories(): Promise<Category[]>
  accounts(): Promise<Account[]>
  rates(): Promise<FxRate[]>
  /** rows of a soft table that sit in the bin (deleted_at set, deleted = false) */
  binned(table: SoftTable): Promise<{ id: string; deleted: boolean; deleted_at: string | null; deleted_batch: string | null }[]>
  markDeleted(table: SoftTable, ids: string[]): Promise<void>
  fetchNbu(date: string, currencies: string[]): Promise<FxRate[]>
  writeRates(rows: FxRate[]): Promise<void>
  patchTx(id: string, patch: Partial<Transaction>): Promise<void>
  deleteBotUpdatesBefore(iso: string): Promise<void>
  webhookInfo(): Promise<WebhookInfo>
  send(chatId: number, text: string): Promise<void>
  sendDocument(chatId: number, filename: string, content: string, caption: string): Promise<void>
}

export interface KeepaliveOptions {
  now: Date
  ownerChatId: number
  partnerChatId: number | null
  /** the telegram-bot function URL the webhook must point at */
  webhookUrl: string
  /** ms clock for db_ms (injectable) */
  clock?: () => number
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
const usd = (n: number) => money(n, 'USD')

/** One reminder per gap: ≥ N days since the last record, and not yet reminded for this gap (or N more days passed). */
export function reminderDue(lastRecordAt: string | null, lastReminderAt: string | null, days: number, nowMs: number): boolean {
  if (days <= 0 || !lastRecordAt) return false
  const span = days * DAY_MS
  if (nowMs - Date.parse(lastRecordAt) < span) return false
  if (!lastReminderAt || lastReminderAt < lastRecordAt) return true
  return nowMs - Date.parse(lastReminderAt) >= span
}

export function reminderText(days: number): string {
  return `${days} ${plural(days, 'день', 'дня', 'дней')} без записей — всё в порядке? Запиши траты (можно голосом) или проверь связь: /ping`
}

/** The text of a webhook problem worth telling Kirill about, or null. */
export function webhookProblem(info: WebhookInfo, expectedUrl: string, nowMs: number): string | null {
  if (info.url !== expectedUrl) return `вебхук указывает на другой адрес (${info.url || 'пусто'})`
  if (info.last_error_date && nowMs - info.last_error_date * 1000 <= DAY_MS) return info.last_error_message || 'ошибка доставки'
  if (info.pending_update_count > QUEUE_LIMIT) return `в очереди ${info.pending_update_count} сообщений`
  return null
}

/** The latest created_at among records of every kind and goal moves, of either author. */
export function lastRecordAt(txs: Transaction[], moves: GoalMove[]): string | null {
  let last: string | null = null
  for (const r of [...txs.filter(alive), ...moves.filter((m) => !m.deleted)]) if (!last || r.created_at > last) last = r.created_at
  return last
}

/** «📅 Итог дня: потрачено $36.68 (Я $25 · Маша $11.68) · на завтра $59.80 в день · записей: 6». */
export function dailySummary(s: Settings, txs: Transaction[], moves: GoalMove[], goals: Goal[], accounts: Account[], rates: FxRate[], today: string): string {
  const live = txs.filter(alive)
  const day = live.filter((t) => t.date === today)
  if (day.length === 0) return '📅 Сегодня записей не было — ничего не забыли?'
  const exp = day.filter((t) => t.kind === 'expense')
  const sum = (rows: Transaction[]) => round2(rows.reduce((a, t) => a + t.amount_usd, 0))
  const her = exp.filter((t) => t.author === 'partner')
  const split = her.length ? ` (Я ${usd(sum(exp.filter((t) => t.author === 'owner')))} · ${s.partner_name?.trim() || 'Она'} ${usd(sum(her))})` : ''
  const b = dailyBudget({ txs: live, rates, accounts, reservedUsd: reservedUsd(reservingGoalMoves(moves, goals)), settings: s, today: addDays(today, 1) })
  const tomorrow = b.state === 'no_date' || b.state === 'sea' ? '' : ` · на завтра ${usd(b.perDay)} в день`
  return `📅 Итог дня: потрачено ${usd(sum(exp))}${split}${tomorrow} · записей: ${day.length}`
}

/** Pending rates: one NBU call per date that lacks an exact rate (≤ 31 dates a run), then recompute. */
async function fixPendingRates(deps: KeepaliveDeps, s: Settings, txs: Transaction[]): Promise<number> {
  const pending = txs.filter((t) => alive(t) && t.rate_pending)
  if (pending.length === 0) return 0
  const rates = await deps.rates()
  const dates = [...new Set(pending.map((t) => t.date))].sort().slice(-MAX_RATE_DATES)
  for (const date of dates) {
    const need = new Set([...s.currencies, ...pending.filter((t) => t.date === date).map((t) => t.currency)])
    if ([...need].every((c) => c === 'USD' || usdRate(rates, c, date)?.exact)) continue
    try {
      const rows = await deps.fetchNbu(date, [...need])
      if (rows.length) {
        await deps.writeRates(rows)
        rates.push(...rows)
      }
    } catch (e) {
      console.error(`NBU ${date}:`, e instanceof Error ? e.message : String(e))
    }
  }
  let fixed = 0
  for (const t of pending) {
    const r = usdRate(rates, t.currency, t.date)
    if (!r || !r.exact) continue
    await deps.patchTx(t.id, { rate_usd: r.rate, amount_usd: round2(t.amount * r.rate), rate_pending: false })
    fixed++
  }
  return fixed
}

export async function runKeepalive(deps: KeepaliveDeps, o: KeepaliveOptions): Promise<{ db_ms: number; done: string[] }> {
  const clock = o.clock ?? (() => Date.now())
  const nowMs = o.now.getTime()
  const done: string[] = []
  const started = clock()
  const s = await deps.settings()
  const db_ms = Math.max(0, Math.round(clock() - started))
  if (!s) return { db_ms, done }
  await deps.updateSettings({ keepalive_at: o.now.toISOString() })
  done.push('keepalive')

  // every job is independent: one failing must not stop the others
  const job = async (name: string, f: () => Promise<unknown>) => {
    try {
      await f()
      done.push(name)
    } catch (e) {
      console.error(`keepalive ${name}:`, e instanceof Error ? e.message : String(e))
    }
  }
  const [txs, moves] = await Promise.all([deps.transactions(), deps.goalMoves()])
  const today = localDate(o.now, s.timezone)
  const chats = [o.ownerChatId, ...(o.partnerChatId !== null ? [o.partnerChatId] : [])]

  await job('reminder', async () => {
    if (!reminderDue(lastRecordAt(txs, moves), s.last_reminder_at, s.remind_after_days, nowMs)) return
    for (const c of chats) await deps.send(c, reminderText(s.remind_after_days))
    await deps.updateSettings({ last_reminder_at: o.now.toISOString() })
  })

  const morning = o.now.getUTCHours() < 12
  if (!morning) {
    await job('summary', async () => {
      const targets = [s.daily_summary_owner && o.ownerChatId, s.daily_summary_partner && o.partnerChatId].filter((c): c is number => typeof c === 'number')
      if (targets.length === 0) return
      const [goals, accounts, rates] = await Promise.all([deps.goals(), deps.accounts(), deps.rates()])
      const text = dailySummary(s, txs, moves, goals, accounts, rates, today)
      for (const c of targets) await deps.send(c, text)
    })
    return { db_ms, done }
  }

  const [y, m, d] = today.split('-').map(Number)
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0) {
    await job('backup', async () => {
      const [categories, accounts] = await Promise.all([deps.categories(), deps.accounts()])
      const rows = txs.filter(alive).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      const n = rows.length
      await deps.sendDocument(o.ownerChatId, `seafarer-budget-${today}.csv`, toCsv(rows, categories, accounts, s.partner_name),
        `Резервная копия · ${n} ${plural(n, 'запись', 'записи', 'записей')} · открыть в Excel`)
    })
  }
  await job('webhook', async () => {
    const problem = webhookProblem(await deps.webhookInfo(), o.webhookUrl, nowMs)
    if (problem) await deps.send(o.ownerChatId, `⚠️ Telegram не может доставить сообщения боту: ${problem}`)
  })
  await job('rates', () => fixPendingRates(deps, s, txs))
  await job('purge', async () => {
    for (const t of SOFT_TABLES) {
      const ids = purgeDue(await deps.binned(t), nowMs)
      if (ids.length) await deps.markDeleted(t, ids)
    }
  })
  await job('bot_updates', () => deps.deleteBotUpdatesBefore(new Date(nowMs - BOT_UPDATES_DAYS * DAY_MS).toISOString()))
  return { db_ms, done }
}

/** The HTTP entry: POST with X-Keepalive-Secret only (401 otherwise, nothing done). */
export async function handleKeepalive(req: Request, deps: KeepaliveDeps, o: KeepaliveOptions, secret: string): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!secret || req.headers.get('X-Keepalive-Secret') !== secret) return new Response('Unauthorized', { status: 401 })
  try {
    const r = await runKeepalive(deps, o)
    return new Response(JSON.stringify({ ok: true, ...r }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('keepalive failed:', e instanceof Error ? e.message : String(e))
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
