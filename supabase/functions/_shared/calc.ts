// Budget calculations. Pure functions, shared by the Telegram bot (Deno) and the React app.
// Dead rows (`!alive(row)`: deleted for good or in the 24 h undo bin) are never counted; archived rows are.
// `round2` is applied to aggregate outputs only.

import { alive } from './alive.ts'
import { addDays, daysBetween, monthOf, prevMonth } from './dates.ts'
import { round2, usdRate } from './fx.ts'
import type { FxRate, Goal, GoalMove, Limit, Settings, Transaction } from './types.ts'

const DAYS_PER_MONTH = 30.4
const WARN_SHARE = 0.8
const OVER_SHARE = 1.0
const PACE_WINDOW_DAYS = 90
const MAX_ETA_DAYS = 36_500 // 100 years
const TOP_COUNT = 5
const UNCATEGORIZED = 'uncategorized'

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

/**
 * Balance per currency. With `accountId`, only that account's movements are counted.
 * `skipAccounts` (e.g. archived accounts) are left out: each leg of a transfer/exchange counts
 * only on the side whose account is kept.
 */
export function balances(
  txs: Transaction[],
  accountId?: string,
  opts: { skipAccounts?: Iterable<string> } = {},
): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (currency: string, delta: number) => {
    out[currency] = (out[currency] ?? 0) + delta
  }
  const skip = new Set(opts.skipAccounts ?? [])
  const on = (id: string | null) => (accountId === undefined || id === accountId) && !(id !== null && skip.has(id))

  for (const t of txs) {
    if (!alive(t)) continue
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

/** Balances over every non-archived account (spec §4: free money counts only live accounts). */
export function activeBalances(txs: Transaction[], accounts: { id: string; archived: boolean }[]): Record<string, number> {
  return balances(txs, undefined, { skipAccounts: accounts.filter((a) => a.archived).map((a) => a.id) })
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
    sum(moves.filter((m) => alive(m) && (goalId === undefined || m.goal_id === goalId)).map((m) => m.amount_usd)),
  )
}

export interface MonthReport {
  totalUsd: number
  prevTotalUsd: number
  byCategory: { categoryId: string; usd: number; share: number }[]
  top: Transaction[]
}

function monthExpenses(txs: Transaction[], month: string): Transaction[] {
  return txs.filter((t) => alive(t) && t.kind === 'expense' && monthOf(t.date) === month)
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

/**
 * How much can be spent per day / per month until the next contract pays out (date + salary lag).
 * @deprecated use dailyBudget — removed in stage 4
 */
export function allowance(freeUsd: number, s: Settings, today: string): Allowance {
  if (!s.next_contract_date) return { status: 'no_date' }
  const days = daysBetween(today, addDays(s.next_contract_date, s.salary_lag_days))
  if (days <= 0) return { status: 'expired' }
  const perDay = freeUsd / days
  return { status: 'ok', days, perDay: round2(perDay), perMonth: round2(perDay * DAYS_PER_MONTH) }
}

export type DailyBudget =
  | {
      state: 'ok' | 'overspent' | 'reserve'
      days: number
      balanceMorningUsd: number
      freeMorningUsd: number
      perDay: number
      spentToday: number
      leftToday: number
    }
  | { state: 'no_date'; spentToday: number }
  | { state: 'sea'; spentToday: number }

/**
 * Daily budget (spec §2). Recomputed every morning from the balance at the start of `today`:
 * every movement dated `today` is rolled back by leaving it out of the balance, so the budget
 * stays fixed during the day and spending only fills the bar.
 *  days = daysBetween(today, landing) + 1;  perDay = max(0, free) / days;  left = perDay - spentToday.
 * States: no_date (no landing date), sea (today after landing), reserve (free <= 0, perDay 0),
 * overspent (left < 0), ok. `leftToday` uses the rounded `perDay`, so the shown numbers add up.
 */
export function dailyBudget(input: {
  txs: Transaction[]
  rates: FxRate[]
  accounts: { id: string; archived: boolean }[]
  reservedUsd: number
  settings: Pick<Settings, 'next_contract_date' | 'reserve_usd'>
  today: string
}): DailyBudget {
  const { txs, rates, accounts, settings: s, today } = input
  const spentToday = round2(
    sum(txs.filter((t) => alive(t) && t.kind === 'expense' && t.date === today).map((t) => t.amount_usd)),
  )
  if (!s.next_contract_date) return { state: 'no_date', spentToday }
  if (today > s.next_contract_date) return { state: 'sea', spentToday }

  const days = daysBetween(today, s.next_contract_date) + 1
  const balanceMorningUsd = balanceUsd(
    activeBalances(txs.filter((t) => t.date !== today), accounts),
    rates,
    today,
  )
  const freeMorningUsd = round2(balanceMorningUsd - input.reservedUsd - s.reserve_usd)
  const perDay = round2(Math.max(0, freeMorningUsd) / days)
  const leftToday = round2(perDay - spentToday)
  const state = freeMorningUsd <= 0 ? 'reserve' : leftToday < 0 ? 'overspent' : 'ok'
  return { state, days, balanceMorningUsd, freeMorningUsd, perDay, spentToday, leftToday }
}

export function contractStats(
  txs: Transaction[],
  s: Settings,
  today: string,
): { earnedUsd: number; savedThisMonthUsd: number; projectedUsd: number | null } {
  const live = txs.filter(alive)
  const start = s.contract_start_date
  const earned = start
    ? sum(live.filter((t) => t.kind === 'income' && t.date >= start).map((t) => t.amount_usd))
    : 0

  const month = monthOf(today)
  const inMonth = live.filter((t) => monthOf(t.date) === month)
  const saved =
    sum(inMonth.filter((t) => t.kind === 'income').map((t) => t.amount_usd)) -
    sum(inMonth.filter((t) => t.kind === 'expense').map((t) => t.amount_usd))

  // projected = projected NET savings over the whole contract:
  //   net  = income - expense (amount_usd) for start <= date <= today
  //   pace = net / max(1, days from start to today)
  //   projected = net + pace * max(0, days from today to end)
  // Needs both contract_start_date and contract_end_date, otherwise null.
  // After the end date there are no days left, so projected equals net.
  let projected: number | null = null
  if (start && s.contract_end_date) {
    const inContract = live.filter((t) => t.date >= start && t.date <= today)
    const net =
      sum(inContract.filter((t) => t.kind === 'income').map((t) => t.amount_usd)) -
      sum(inContract.filter((t) => t.kind === 'expense').map((t) => t.amount_usd))
    const pace = net / Math.max(1, daysBetween(start, today))
    projected = round2(net + pace * Math.max(0, daysBetween(today, s.contract_end_date)))
  }

  return { earnedUsd: round2(earned), savedThisMonthUsd: round2(saved), projectedUsd: projected }
}

export function goalProgress(
  goal: Goal,
  moves: GoalMove[],
  today: string,
): { savedUsd: number; share: number; etaDate: string | null; perMonthNeeded: number | null } {
  const mine = moves.filter((m) => alive(m) && m.goal_id === goal.id)
  const saved = sum(mine.map((m) => m.amount_usd))
  const remaining = goal.target_usd - saved
  const share = goal.target_usd > 0 ? saved / goal.target_usd : 0

  // ETA: average daily pace over the last 90 days (today and the 89 days before it).
  const windowStart = addDays(today, -(PACE_WINDOW_DAYS - 1))
  const recent = sum(mine.filter((m) => m.date >= windowStart && m.date <= today).map((m) => m.amount_usd))
  const pace = recent / PACE_WINDOW_DAYS
  let etaDate: string | null = null
  if (remaining > 0 && pace > 0) {
    // more than 100 years away is not a meaningful ETA (and would overflow Date)
    const etaDays = Math.ceil(remaining / pace - 1e-9)
    if (etaDays <= MAX_ETA_DAYS) etaDate = addDays(today, etaDays)
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
