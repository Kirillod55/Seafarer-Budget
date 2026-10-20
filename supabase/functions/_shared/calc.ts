// Budget calculations. Pure functions, shared by the Telegram bot (Deno) and the React app.
// Deleted rows (`deleted: true`) are never counted. `round2` is applied to aggregate outputs only.

import { addDays, daysBetween, monthOf, prevMonth } from './dates.ts'
import { round2, usdRate } from './fx.ts'
import type { FxRate, Goal, GoalMove, Limit, Settings, Transaction } from './types.ts'

const DAYS_PER_MONTH = 30.4
const WARN_SHARE = 0.8
const OVER_SHARE = 1.0
const PACE_WINDOW_DAYS = 90
const TOP_COUNT = 5
const UNCATEGORIZED = 'uncategorized'

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

/** Balance per currency. With `accountId`, only that account's movements are counted. */
export function balances(txs: Transaction[], accountId?: string): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (currency: string, delta: number) => {
    out[currency] = (out[currency] ?? 0) + delta
  }
  const on = (id: string | null) => accountId === undefined || id === accountId

  for (const t of txs) {
    if (t.deleted) continue
    switch (t.kind) {
      case 'expense':
        if (on(t.account_id)) add(t.currency, -t.amount)
        break
      case 'income':
      case 'adjustment': // adjustment amount is signed
        if (on(t.account_id)) add(t.currency, t.amount)
        break
      case 'transfer':
        if (on(t.account_id)) add(t.currency, -t.amount)
        if (t.to_account_id !== null && on(t.to_account_id)) add(t.currency, t.amount)
        break
      case 'exchange':
        // the received side lands on to_account_id, or on the same account when it is not set
        if (on(t.account_id)) add(t.currency, -t.amount)
        if (t.to_currency !== null && t.to_amount !== null && on(t.to_account_id ?? t.account_id)) {
          add(t.to_currency, t.to_amount)
        }
        break
    }
  }
  for (const cur of Object.keys(out)) out[cur] = round2(out[cur])
  return out
}

/** Total of per-currency balances in USD at the latest known rate; currencies without a rate are skipped. */
export function balanceUsd(bal: Record<string, number>, rates: FxRate[], today: string): number {
  let total = 0
  for (const [cur, amount] of Object.entries(bal)) {
    const r = usdRate(rates, cur, today)
    if (r) total += amount * r.rate
  }
  return round2(total)
}

/** USD set aside for goals (all goals, or only `goalId`). */
export function reservedUsd(moves: GoalMove[], goalId?: string): number {
  return round2(
    sum(moves.filter((m) => !m.deleted && (goalId === undefined || m.goal_id === goalId)).map((m) => m.amount_usd)),
  )
}

export interface MonthReport {
  totalUsd: number
  prevTotalUsd: number
  byCategory: { categoryId: string; usd: number; share: number }[]
  top: Transaction[]
}

function monthExpenses(txs: Transaction[], month: string): Transaction[] {
  return txs.filter((t) => !t.deleted && t.kind === 'expense' && monthOf(t.date) === month)
}

export function monthReport(txs: Transaction[], month: string): MonthReport {
  const cur = monthExpenses(txs, month)
  const total = sum(cur.map((t) => t.amount_usd))

  const perCat = new Map<string, number>()
  for (const t of cur) {
    const key = t.category_id ?? UNCATEGORIZED
    perCat.set(key, (perCat.get(key) ?? 0) + t.amount_usd)
  }
  const byCategory = [...perCat.entries()]
    .map(([categoryId, usd]) => ({ categoryId, usd, share: total === 0 ? 0 : usd / total }))
    .sort((a, b) => b.usd - a.usd)
    .map((c) => ({ ...c, usd: round2(c.usd) }))

  const top = [...cur].sort((a, b) => b.amount_usd - a.amount_usd).slice(0, TOP_COUNT)

  return {
    totalUsd: round2(total),
    prevTotalUsd: round2(sum(monthExpenses(txs, prevMonth(month)).map((t) => t.amount_usd))),
    byCategory,
    top,
  }
}

export type Allowance =
  | { status: 'ok'; days: number; perDay: number; perMonth: number }
  | { status: 'no_date' }
  | { status: 'expired' }

/** How much can be spent per day / per month until the next contract pays out (date + salary lag). */
export function allowance(freeUsd: number, s: Settings, today: string): Allowance {
  if (!s.next_contract_date) return { status: 'no_date' }
  const days = daysBetween(today, addDays(s.next_contract_date, s.salary_lag_days))
  if (days <= 0) return { status: 'expired' }
  const perDay = freeUsd / days
  return { status: 'ok', days, perDay: round2(perDay), perMonth: round2(perDay * DAYS_PER_MONTH) }
}

export function contractStats(
  txs: Transaction[],
  s: Settings,
  today: string,
): { earnedUsd: number; savedThisMonthUsd: number; projectedUsd: number | null } {
  const live = txs.filter((t) => !t.deleted)
  const start = s.contract_start_date
  const earned = start
    ? sum(live.filter((t) => t.kind === 'income' && t.date >= start).map((t) => t.amount_usd))
    : 0

  const month = monthOf(today)
  const inMonth = live.filter((t) => monthOf(t.date) === month)
  const saved =
    sum(inMonth.filter((t) => t.kind === 'income').map((t) => t.amount_usd)) -
    sum(inMonth.filter((t) => t.kind === 'expense').map((t) => t.amount_usd))

  // projected = earned so far + (this month's saved / days elapsed this month) * days until contract end.
  // Simple linear estimate; past the end date there are no days left, so projected equals earned.
  let projected: number | null = null
  if (s.contract_end_date) {
    const daysLeft = Math.max(0, daysBetween(today, s.contract_end_date))
    const elapsed = Number(today.slice(8, 10))
    projected = round2(earned + (saved / elapsed) * daysLeft)
  }

  return { earnedUsd: round2(earned), savedThisMonthUsd: round2(saved), projectedUsd: projected }
}

export function goalProgress(
  goal: Goal,
  moves: GoalMove[],
  today: string,
): { savedUsd: number; share: number; etaDate: string | null; perMonthNeeded: number | null } {
  const mine = moves.filter((m) => !m.deleted && m.goal_id === goal.id)
  const saved = sum(mine.map((m) => m.amount_usd))
  const remaining = goal.target_usd - saved
  const share = goal.target_usd > 0 ? saved / goal.target_usd : 0

  // ETA: average daily pace over the last 90 days (today and the 89 days before it).
  const windowStart = addDays(today, -(PACE_WINDOW_DAYS - 1))
  const recent = sum(mine.filter((m) => m.date >= windowStart && m.date <= today).map((m) => m.amount_usd))
  const pace = recent / PACE_WINDOW_DAYS
  let etaDate: string | null = null
  if (remaining > 0 && pace > 0) {
    etaDate = addDays(today, Math.ceil(remaining / pace - 1e-9))
  }

  // Needed per month until the deadline (months = days / 30.4).
  // 0 when already reached, null without a deadline or when the deadline has passed.
  let perMonthNeeded: number | null = null
  if (goal.deadline) {
    const days = daysBetween(today, goal.deadline)
    if (remaining <= 0) perMonthNeeded = 0
    else if (days > 0) perMonthNeeded = round2(remaining / (days / DAYS_PER_MONTH))
  }

  return { savedUsd: round2(saved), share, etaDate, perMonthNeeded }
}

export function limitStatus(
  limit: Limit,
  txs: Transaction[],
  month: string,
): { spentUsd: number; share: number; level: 'ok' | 'warn' | 'over' } {
  const spent = round2(
    sum(monthExpenses(txs, month).filter((t) => t.category_id === limit.category_id).map((t) => t.amount_usd)),
  )
  // A zero/negative limit has no meaningful share: treat as unlimited.
  const share = limit.monthly_usd > 0 ? spent / limit.monthly_usd : 0
  const level = share >= OVER_SHARE ? 'over' : share >= WARN_SHARE ? 'warn' : 'ok'
  return { spentUsd: spent, share, level }
}

/** Which threshold was crossed upward when the share moved from `before` to `after` (the higher one wins). */
export function limitCrossing(before: number, after: number): 'warn' | 'over' | null {
  if (before < OVER_SHARE && after >= OVER_SHARE) return 'over'
  if (before < WARN_SHARE && after >= WARN_SHARE) return 'warn'
  return null
}
