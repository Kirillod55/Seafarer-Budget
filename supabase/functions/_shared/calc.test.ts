import { describe, expect, it } from 'vitest'
import {
  balances,
  balanceUsd,
  contractStats,
  dailyBudget,
  goalProgress,
  limitCrossing,
  limitStatus,
  reservingGoalMoves,
  monthReport,
  reservedUsd,
} from './calc.ts'
import { addDays, localDate } from './dates.ts'
import type { FxRate, Goal, GoalMove, Limit, Settings, Transaction } from './types.ts'

let seq = 0
function tx(p: Partial<Transaction>): Transaction {
  return {
    id: `t${++seq}`,
    deleted: false,
    kind: 'expense',
    amount: 0,
    currency: 'USD',
    rate_usd: 1,
    amount_usd: 0,
    rate_pending: false,
    account_id: 'a1',
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: null,
    date: '2026-10-10',
    note: '',
    source: 'app',
    created_at: '2026-10-10T00:00:00Z',
    author: 'owner',
    archived: false,
    deleted_at: null,
    deleted_batch: null,
    ...p,
  }
}

function settings(p: Partial<Settings> = {}): Settings {
  return {
    id: 's1',
    deleted: false,
    base_currency: 'USD',
    default_currency: 'USD',
    currencies: ['USD', 'UAH'],
    accounts_mode: 'single',
    status: 'home',
    next_contract_date: null,
    contract_start_date: null,
    contract_end_date: null,
    salary_lag_days: 0,
    timezone: 'UTC',
    reserve_usd: 0,
    partner_name: null,
    partner_seen_at: null,
    remind_after_days: 2,
    last_reminder_at: null,
    keepalive_at: null,
    daily_summary_owner: false,
    daily_summary_partner: false,
    ...p,
  }
}

function move(p: Partial<GoalMove>): GoalMove {
  return { id: `m${++seq}`, deleted: false, goal_id: 'g1', amount_usd: 0, date: '2026-10-01', note: '', author: 'owner', source: 'app', created_at: '2026-10-01T12:00:00.000Z', ...p }
}

describe('balances', () => {
  const txs = [
    tx({ kind: 'adjustment', amount: 5000, currency: 'UAH' }),
    tx({ kind: 'expense', amount: 80, currency: 'UAH' }),
    tx({ kind: 'exchange', amount: 4120, currency: 'UAH', to_amount: 100, to_currency: 'USD' }),
  ]

  it('applies signs per kind', () => {
    expect(balances(txs)).toEqual({ UAH: 800, USD: 100 })
  })

  it('adds income and applies signed adjustments', () => {
    const b = balances([
      tx({ kind: 'income', amount: 1000, currency: 'USD' }),
      tx({ kind: 'adjustment', amount: -50, currency: 'USD' }),
    ])
    expect(b).toEqual({ USD: 950 })
  })

  it('ignores deleted rows', () => {
    expect(balances([...txs, tx({ kind: 'income', amount: 999, currency: 'UAH', deleted: true })])).toEqual({
      UAH: 800,
      USD: 100,
    })
  })

  it('transfer keeps the total but moves money between accounts', () => {
    const all = [
      tx({ kind: 'adjustment', amount: 1000, currency: 'USD', account_id: 'a1' }),
      tx({ kind: 'transfer', amount: 300, currency: 'USD', account_id: 'a1', to_account_id: 'a2' }),
    ]
    expect(balances(all).USD).toBe(1000)
    expect(balances(all, 'a1')).toEqual({ USD: 700 })
    expect(balances(all, 'a2')).toEqual({ USD: 300 })
  })

  it('exchange within one account filtered by account', () => {
    expect(balances(txs, 'a1')).toEqual({ UAH: 800, USD: 100 })
    expect(balances(txs, 'other')).toEqual({})
  })

  it('M1: skipAccounts leaves out archived accounts; transfer semantics unchanged', () => {
    const all = [
      tx({ kind: 'adjustment', amount: 1000, currency: 'USD', account_id: 'a1' }),
      tx({ kind: 'income', amount: 500, currency: 'USD', account_id: 'old' }),
      tx({ kind: 'transfer', amount: 200, currency: 'USD', account_id: 'old', to_account_id: 'a1' }),
      tx({ kind: 'exchange', amount: 100, currency: 'USD', account_id: 'old', to_amount: 4000, to_currency: 'UAH' }),
    ]
    // only a1 counts: 1000 + 200 received from the archived account
    expect(balances(all, undefined, { skipAccounts: ['old'] })).toEqual({ USD: 1200 })
    expect(balances(all)).toEqual({ USD: 1400, UAH: 4000 })
    expect(balances(all, 'a1', { skipAccounts: ['old'] })).toEqual({ USD: 1200 })
  })

  it('rounds floating point drift', () => {
    const b = balances([
      tx({ kind: 'income', amount: 0.1 }),
      tx({ kind: 'income', amount: 0.2 }),
    ])
    expect(b.USD).toBe(0.3)
  })
})

describe('balanceUsd', () => {
  const rates: FxRate[] = [
    { date: '2026-10-20', currency: 'USD', uah_per_unit: 40 },
    { date: '2026-10-20', currency: 'EUR', uah_per_unit: 44 },
    { date: '2026-10-20', currency: 'UAH', uah_per_unit: 1 },
  ]

  it('converts with the latest known rate', () => {
    expect(balanceUsd({ USD: 100, UAH: 800, EUR: 100 }, rates, '2026-10-21')).toBe(100 + 20 + 110)
  })

  it('skips currencies without a rate', () => {
    expect(balanceUsd({ USD: 100, PLN: 500 }, rates, '2026-10-21')).toBe(100)
  })
})

describe('reservedUsd', () => {
  const moves = [
    move({ goal_id: 'g1', amount_usd: 100.1 }),
    move({ goal_id: 'g1', amount_usd: 0.2 }),
    move({ goal_id: 'g2', amount_usd: 50 }),
    move({ goal_id: 'g1', amount_usd: 999, deleted: true }),
  ]
  it('sums non-deleted moves, optionally per goal', () => {
    expect(reservedUsd(moves)).toBe(150.3)
    expect(reservedUsd(moves, 'g1')).toBe(100.3)
  })
})

describe('reservingGoalMoves', () => {
  const g = (id: string, p: Partial<Goal> = {}): Goal => ({
    id, deleted: false, deleted_at: null, deleted_batch: null, name: id, target_usd: 1000, deadline: null, archived: false, ...p,
  })
  const moves = [
    move({ id: 'm1', goal_id: 'live', amount_usd: 100 }),
    move({ id: 'm2', goal_id: 'binned', amount_usd: 40 }),
    move({ id: 'm3', goal_id: 'final', amount_usd: 30 }),
    move({ id: 'm4', goal_id: 'missing', amount_usd: 20 }),
    move({ id: 'm5', goal_id: 'live', amount_usd: 7, deleted: true }),
  ]
  const goals = [g('live'), g('binned', { deleted_at: '2026-10-21T10:00:00.000Z', deleted_batch: 'b1' }), g('final', { deleted: true })]

  // spec §4: an archived goal «не участвует в бюджете»
  it('an archived goal reserves nothing; taken out of the archive it reserves again', () => {
    const withArchived = [...goals, g('old', { archived: true })]
    const all = [...moves, move({ id: 'm6', goal_id: 'old', amount_usd: 500 })]
    expect(reservingGoalMoves(all, withArchived).map((m) => m.id)).toEqual(['m1'])
    expect(reservedUsd(reservingGoalMoves(all, withArchived))).toBe(100)
    const unarchived = withArchived.map((x) => (x.id === 'old' ? { ...x, archived: false } : x))
    expect(reservedUsd(reservingGoalMoves(all, unarchived))).toBe(600)
  })

  it('keeps only live moves of live goals, so a wiped goal reserves nothing', () => {
    expect(reservingGoalMoves(moves, goals).map((m) => m.id)).toEqual(['m1'])
    expect(reservedUsd(reservingGoalMoves(moves, goals))).toBe(100)
  })

  it('a restored goal reserves its money again', () => {
    const restored = goals.map((x) => (x.id === 'binned' ? { ...x, deleted_at: null, deleted_batch: null } : x))
    expect(reservedUsd(reservingGoalMoves(moves, restored))).toBe(140)
  })
})

describe('monthReport', () => {
  it('sums floats exactly after rounding (0.1 + 0.2 = 0.3)', () => {
    const r = monthReport(
      [
        tx({ amount_usd: 0.1, category_id: 'c1' }),
        tx({ amount_usd: 0.2, category_id: 'c1' }),
      ],
      '2026-10',
    )
    expect(r.totalUsd).toBe(0.3)
    expect(r.byCategory).toEqual([{ categoryId: 'c1', usd: 0.3, share: 1 }])
  })

  it('sorts categories by usd desc and computes shares', () => {
    const r = monthReport(
      [
        tx({ amount_usd: 10, category_id: 'small' }),
        tx({ amount_usd: 30, category_id: 'big' }),
        tx({ amount_usd: 10, category_id: 'big' }),
        tx({ amount_usd: 50, category_id: 'mid' }),
      ],
      '2026-10',
    )
    expect(r.byCategory.map((c) => c.categoryId)).toEqual(['mid', 'big', 'small'])
    expect(r.byCategory.find((c) => c.categoryId === 'big')).toEqual({ categoryId: 'big', usd: 40, share: 0.4 })
  })

  it('top has at most 5 entries, largest first', () => {
    const txs = [1, 2, 3, 4, 5, 6, 7].map((n) => tx({ amount_usd: n, category_id: 'c' }))
    const r = monthReport(txs, '2026-10')
    expect(r.top).toHaveLength(5)
    expect(r.top.map((t) => t.amount_usd)).toEqual([7, 6, 5, 4, 3])
  })

  it('computes prevTotalUsd and ignores other months, kinds and deleted rows', () => {
    const r = monthReport(
      [
        tx({ amount_usd: 10, date: '2026-10-05' }),
        tx({ amount_usd: 7, date: '2026-09-30' }),
        tx({ amount_usd: 3, date: '2026-09-01' }),
        tx({ amount_usd: 500, date: '2026-10-05', kind: 'income' }),
        tx({ amount_usd: 500, date: '2026-10-05', deleted: true }),
        tx({ amount_usd: 500, date: '2026-08-05' }),
      ],
      '2026-10',
    )
    expect(r.totalUsd).toBe(10)
    expect(r.prevTotalUsd).toBe(10)
  })

  it('share is 0 when total is 0', () => {
    const r = monthReport([tx({ amount_usd: 0, category_id: 'c' })], '2026-10')
    expect(r.totalUsd).toBe(0)
    expect(r.byCategory[0].share).toBe(0)
  })

  it('handles January -> previous December', () => {
    const r = monthReport([tx({ amount_usd: 4, date: '2025-12-31' })], '2026-01')
    expect(r.prevTotalUsd).toBe(4)
  })
})

describe('contractStats', () => {
  const s = settings({ contract_start_date: '2026-08-01' })
  const txs = [
    tx({ kind: 'income', amount_usd: 1000, date: '2026-07-31' }),
    tx({ kind: 'income', amount_usd: 2000, date: '2026-08-01' }),
    tx({ kind: 'income', amount_usd: 500, date: '2026-10-05' }),
    tx({ kind: 'income', amount_usd: 9999, date: '2026-10-05', deleted: true }),
    tx({ kind: 'expense', amount_usd: 200, date: '2026-10-06' }),
    tx({ kind: 'expense', amount_usd: 300, date: '2026-09-06' }),
  ]

  it('earnedUsd sums income since the contract start', () => {
    expect(contractStats(txs, s, '2026-10-21').earnedUsd).toBe(2500)
  })

  it('earnedUsd is 0 without contract start', () => {
    expect(contractStats(txs, settings(), '2026-10-21').earnedUsd).toBe(0)
  })

  it('savedThisMonthUsd = income - expense in the current month', () => {
    expect(contractStats(txs, s, '2026-10-21').savedThisMonthUsd).toBe(300)
  })

  it('projectedUsd is null without contract_end_date', () => {
    expect(contractStats(txs, s, '2026-10-21').projectedUsd).toBeNull()
  })

  describe('projectedUsd (projected net savings over the contract)', () => {
    // window 2026-09-01..2026-10-01 = 30 days: income 3000, expenses 600 -> net 2400, pace 80/day
    const wtxs = [
      tx({ kind: 'income', amount_usd: 3000, date: '2026-09-15' }),
      tx({ kind: 'expense', amount_usd: 400, date: '2026-09-20' }),
      tx({ kind: 'expense', amount_usd: 200, date: '2026-10-01' }),
      tx({ kind: 'income', amount_usd: 7777, date: '2026-08-31' }), // before the contract
      tx({ kind: 'expense', amount_usd: 7777, date: '2026-10-02' }), // after today
      tx({ kind: 'expense', amount_usd: 7777, date: '2026-09-10', deleted: true }),
    ]
    const cs = (p: Partial<Settings>) =>
      contractStats(wtxs, settings({ contract_start_date: '2026-09-01', ...p }), '2026-10-01')

    it('net + pace * days left: 2400 + 80 * 90 = 9600', () => {
      expect(cs({ contract_end_date: '2026-12-30' }).projectedUsd).toBe(9600)
    })

    it('is null when contract_end_date is missing', () => {
      expect(cs({ contract_end_date: null }).projectedUsd).toBeNull()
    })

    it('is null when contract_start_date is missing', () => {
      const r = contractStats(wtxs, settings({ contract_end_date: '2026-12-30' }), '2026-10-01')
      expect(r.projectedUsd).toBeNull()
    })

    it('equals net when the contract has already ended', () => {
      expect(cs({ contract_end_date: '2026-09-20' }).projectedUsd).toBe(2400)
    })

    it('does not change earnedUsd (gross income since start)', () => {
      expect(cs({ contract_end_date: '2026-12-30' }).earnedUsd).toBe(3000)
    })
  })
})

describe('goalProgress', () => {
  const today = '2026-10-21'
  const goal: Goal = { id: 'g1', deleted: false, deleted_at: null, deleted_batch: null, name: 'Car', target_usd: 1000, deadline: null, archived: false }

  it('share and eta from the 90-day pace', () => {
    // 250 saved evenly over the last 90 days -> 2.777/day, 750 left -> 270 days
    const moves = [0, 20, 40, 60, 80].map((n) => move({ amount_usd: 50, date: addDays(today, -n) }))
    const p = goalProgress(goal, moves, today)
    expect(p.savedUsd).toBe(250)
    expect(p.share).toBe(0.25)
    expect(p.etaDate).toBe(addDays(today, 270))
    expect(p.perMonthNeeded).toBeNull()
  })

  it('perMonthNeeded with a deadline six months away', () => {
    const g = { ...goal, deadline: '2027-04-21' }
    const p = goalProgress(g, [move({ amount_usd: 250, date: addDays(today, -10) })], today)
    expect(p.perMonthNeeded).toBeCloseTo(125, 0)
  })

  it('null eta when already reached or pace is not positive', () => {
    const done = goalProgress(goal, [move({ amount_usd: 1000, date: today })], today)
    expect(done.share).toBe(1)
    expect(done.etaDate).toBeNull()
    expect(done.perMonthNeeded).toBeNull()

    const old = goalProgress(goal, [move({ amount_usd: 100, date: addDays(today, -200) })], today)
    expect(old.etaDate).toBeNull()
    expect(goalProgress(goal, [], today).etaDate).toBeNull()
  })

  it('etaDate is null when the ETA is more than 100 years away (tiny pace)', () => {
    // 0.009 in the 90-day window -> 0.0001/day; 1000 left -> 10,000,000 days
    const p = goalProgress(goal, [move({ amount_usd: 0.009, date: today })], today)
    expect(p.etaDate).toBeNull()
    // just inside the bound still yields a date
    const near = goalProgress({ ...goal, target_usd: 365 }, [move({ amount_usd: 9, date: today })], today)
    expect(near.etaDate).toBe(addDays(today, 3560)) // pace 0.1/day, 356 left
  })

  it('ignores deleted moves and other goals', () => {
    const p = goalProgress(
      goal,
      [
        move({ amount_usd: 100, date: today }),
        move({ amount_usd: 900, date: today, deleted: true }),
        move({ amount_usd: 900, date: today, goal_id: 'g2' }),
      ],
      today,
    )
    expect(p.savedUsd).toBe(100)
  })

  it('perMonthNeeded is 0 when reached and null when the deadline passed', () => {
    const reached = goalProgress({ ...goal, deadline: '2027-04-21' }, [move({ amount_usd: 1000, date: today })], today)
    expect(reached.perMonthNeeded).toBe(0)
    const passed = goalProgress({ ...goal, deadline: '2026-10-01' }, [], today)
    expect(passed.perMonthNeeded).toBeNull()
  })
})

describe('limitStatus', () => {
  const limit: Limit = { id: 'l1', deleted: false, deleted_at: null, deleted_batch: null, category_id: 'c1', monthly_usd: 100 }
  const spend = (n: number) => [tx({ amount_usd: n, category_id: 'c1' })]

  it('ok below 80%', () => {
    expect(limitStatus(limit, spend(79), '2026-10')).toEqual({ spentUsd: 79, share: 0.79, level: 'ok' })
  })
  it('warn at 80%', () => {
    expect(limitStatus(limit, spend(80), '2026-10').level).toBe('warn')
  })
  it('over at 100%', () => {
    expect(limitStatus(limit, spend(100), '2026-10').level).toBe('over')
  })
  it('counts only this category, month, expenses, non-deleted', () => {
    const txs = [
      tx({ amount_usd: 10, category_id: 'c1' }),
      tx({ amount_usd: 10, category_id: 'c1', date: '2026-09-10' }),
      tx({ amount_usd: 10, category_id: 'c2' }),
      tx({ amount_usd: 10, category_id: 'c1', kind: 'income' }),
      tx({ amount_usd: 10, category_id: 'c1', deleted: true }),
    ]
    expect(limitStatus(limit, txs, '2026-10').spentUsd).toBe(10)
  })
})

describe('limitCrossing', () => {
  it('detects warn and over crossings', () => {
    expect(limitCrossing(0.79, 0.81)).toBe('warn')
    expect(limitCrossing(0.81, 0.9)).toBeNull()
    expect(limitCrossing(0.95, 1.02)).toBe('over')
    expect(limitCrossing(0.5, 1.2)).toBe('over')
    expect(limitCrossing(1.0, 1.1)).toBeNull()
  })
})

describe('dailyBudget', () => {
  const accounts = [{ id: 'a1', archived: false }]
  const rates: FxRate[] = [
    { date: '2026-10-20', currency: 'USD', uah_per_unit: 40 },
    { date: '2026-10-20', currency: 'UAH', uah_per_unit: 1 },
  ]
  const income = (amount: number, date = '2026-01-01') => tx({ kind: 'income', amount, amount_usd: amount, date })
  const expense = (amount: number, date: string, p: Partial<Transaction> = {}) =>
    tx({ kind: 'expense', amount, amount_usd: amount, date, ...p })
  function run(over: {
    txs?: Transaction[]
    reserved?: number
    reserve?: number
    land?: string | null
    today: string
    accounts?: { id: string; archived: boolean }[]
  }) {
    return dailyBudget({
      txs: over.txs ?? [],
      rates,
      accounts: over.accounts ?? accounts,
      reservedUsd: over.reserved ?? 0,
      settings: { next_contract_date: over.land === undefined ? '2026-12-21' : over.land, reserve_usd: over.reserve ?? 0 },
      today: over.today,
    })
  }

  it('$3600, landing in 59 days (60 days), no reserve -> 60.00', () => {
    const r = run({ txs: [income(3600)], today: '2026-10-22', land: '2026-12-20' })
    expect(r).toMatchObject({ state: 'ok', days: 60, balanceMorningUsd: 3600, freeMorningUsd: 3600, perDay: 60, spentToday: 0, leftToday: 60 })
  })

  it('next day after spending $150 -> 58.47, then after $30 -> 58.97', () => {
    const txs = [income(3600), expense(150, '2026-10-22')]
    const d2 = run({ txs, today: '2026-10-23', land: '2026-12-20' })
    expect(d2).toMatchObject({ state: 'ok', days: 59, balanceMorningUsd: 3450, perDay: 58.47 })
    const d3 = run({ txs: [...txs, expense(30, '2026-10-23')], today: '2026-10-24', land: '2026-12-20' })
    expect(d3).toMatchObject({ days: 58, balanceMorningUsd: 3420, perDay: 58.97 })
  })

  it('$5000 with $1000 reserve over 60 days -> 66.67', () => {
    const r = run({ txs: [income(5000)], reserve: 1000, today: '2026-10-22', land: '2026-12-20' })
    expect(r).toMatchObject({ state: 'ok', days: 60, freeMorningUsd: 4000, perDay: 66.67 })
  })

  it('goal money is set aside before dividing', () => {
    const r = run({ txs: [income(5000)], reserved: 500, reserve: 500, today: '2026-10-22', land: '2026-12-20' })
    expect(r).toMatchObject({ freeMorningUsd: 4000, perDay: 66.67 })
  })

  it('2026-10-22 -> 2026-11-01 is 11 days; landing today is 1 day', () => {
    expect(run({ txs: [income(110)], today: '2026-10-22', land: '2026-11-01' })).toMatchObject({ days: 11, perDay: 10 })
    expect(run({ txs: [income(110)], today: '2026-10-22', land: '2026-10-22' })).toMatchObject({ state: 'ok', days: 1, perDay: 110 })
  })

  it('spent today $36.68 of $59.67 -> left 22.99 (ok); spent $70 -> overspent, left -10.33', () => {
    const base = [income(59.67)]
    const ok = run({ txs: [...base, expense(36.68, '2026-10-22')], today: '2026-10-22', land: '2026-10-22' })
    expect(ok).toMatchObject({ state: 'ok', perDay: 59.67, spentToday: 36.68, leftToday: 22.99 })
    const over = run({ txs: [...base, expense(70, '2026-10-22')], today: '2026-10-22', land: '2026-10-22' })
    expect(over).toMatchObject({ state: 'overspent', perDay: 59.67, spentToday: 70, leftToday: -10.33 })
  })

  it('spending exactly the budget is still ok (left 0)', () => {
    const r = run({ txs: [income(60), expense(60, '2026-10-22')], today: '2026-10-22', land: '2026-10-22' })
    expect(r).toMatchObject({ state: 'ok', leftToday: 0 })
  })

  it('reserve larger than the money -> state reserve, perDay 0', () => {
    const r = run({ txs: [income(500)], reserve: 800, today: '2026-10-22', land: '2026-12-20' })
    expect(r).toMatchObject({ state: 'reserve', perDay: 0, freeMorningUsd: -300 })
    expect(run({ txs: [income(800)], reserve: 800, today: '2026-10-22' })).toMatchObject({ state: 'reserve', perDay: 0 })
  })

  it('reserve wins over overspent when there is no free money', () => {
    const r = run({ txs: [income(100), expense(20, '2026-10-22')], reserve: 200, today: '2026-10-22', land: '2026-12-20' })
    expect(r).toMatchObject({ state: 'reserve', perDay: 0, leftToday: -20 })
  })

  it('no landing date -> no_date, with spentToday', () => {
    const r = run({ txs: [income(100), expense(12.5, '2026-10-22')], today: '2026-10-22', land: null })
    expect(r).toEqual({ state: 'no_date', spentToday: 12.5 })
  })

  it('today after the landing date -> sea, with spentToday', () => {
    const r = run({ txs: [income(100), expense(7, '2026-10-22')], today: '2026-10-22', land: '2026-10-21' })
    expect(r).toEqual({ state: 'sea', spentToday: 7 })
  })

  it("rolls back every movement of today: transfer and exchange don't change the morning balance", () => {
    const base = [income(1000)]
    const transfer = tx({ kind: 'transfer', amount: 300, amount_usd: 300, account_id: 'a1', to_account_id: 'a2', date: '2026-10-22' })
    const exchange = tx({
      kind: 'exchange', amount: 100, amount_usd: 100, account_id: 'a1', to_account_id: 'a2',
      to_amount: 4000, to_currency: 'UAH', date: '2026-10-22',
    })
    const accs = [{ id: 'a1', archived: false }, { id: 'a2', archived: false }]
    const r = run({ txs: [...base, transfer, exchange], accounts: accs, today: '2026-10-22', land: '2026-10-22' })
    expect(r).toMatchObject({ balanceMorningUsd: 1000, spentToday: 0 })
  })

  it("today's income and adjustments are rolled back as well", () => {
    const r = run({
      txs: [income(1000), income(400, '2026-10-22'), tx({ kind: 'adjustment', amount: -50, amount_usd: -50, date: '2026-10-22' })],
      today: '2026-10-22',
      land: '2026-10-22',
    })
    expect(r).toMatchObject({ balanceMorningUsd: 1000 })
  })

  it('archived accounts are not free money', () => {
    const txs = [income(1000), tx({ kind: 'income', amount: 500, amount_usd: 500, account_id: 'a9', date: '2026-01-01' })]
    const r = run({ txs, accounts: [{ id: 'a1', archived: false }, { id: 'a9', archived: true }], today: '2026-10-22', land: '2026-10-22' })
    expect(r).toMatchObject({ balanceMorningUsd: 1000 })
  })

  it("00:30 in Kyiv is already the next day: an entry dated 2026-10-22 counts as today's", () => {
    const today = localDate(new Date('2026-10-21T21:30:00Z'), 'Europe/Kyiv')
    expect(today).toBe('2026-10-22')
    const r = run({ txs: [income(1000), expense(25, '2026-10-22')], today, land: '2026-10-22' })
    expect(r).toMatchObject({ balanceMorningUsd: 1000, spentToday: 25 })
  })

  it('soft-deleted rows are neither balance nor spent today; archived rows count', () => {
    const txs = [
      income(1000),
      expense(300, '2026-10-22', { deleted_at: '2026-10-22T08:00:00Z', deleted_batch: 'b1' }),
      expense(100, '2026-10-20', { deleted_at: '2026-10-21T08:00:00Z' }),
      expense(40, '2026-10-22', { archived: true }),
      expense(10, '2026-10-20', { archived: true }),
    ]
    const r = run({ txs, today: '2026-10-22', land: '2026-10-22' })
    expect(r).toMatchObject({ balanceMorningUsd: 990, spentToday: 40, perDay: 990, leftToday: 950 })
  })
})

describe('soft-deleted rows are ignored by every calculation', () => {
  const gone = { deleted_at: '2026-10-10T09:00:00Z', deleted_batch: 'b1' }

  it('balances', () => {
    const txs = [
      tx({ kind: 'income', amount: 100, amount_usd: 100 }),
      tx({ kind: 'expense', amount: 30, amount_usd: 30, ...gone }),
      tx({ kind: 'expense', amount: 5, amount_usd: 5, archived: true }),
    ]
    expect(balances(txs)).toEqual({ USD: 95 })
  })

  it('reservedUsd and goalProgress', () => {
    const moves = [move({ amount_usd: 100 }), move({ amount_usd: 900, deleted: true })]
    expect(reservedUsd(moves)).toBe(100)
    expect(reservedUsd(moves, 'g1')).toBe(100)
    const goal = { id: 'g1', deleted: false, name: 'x', target_usd: 1000, deadline: null } as unknown as Goal
    expect(goalProgress(goal, moves, '2026-10-20').savedUsd).toBe(100)
  })

  it('monthReport (current and previous month) and limitStatus', () => {
    const txs = [
      tx({ amount: 10, amount_usd: 10, category_id: 'c1', date: '2026-10-05' }),
      tx({ amount: 99, amount_usd: 99, category_id: 'c1', date: '2026-10-06', ...gone }),
      tx({ amount: 20, amount_usd: 20, category_id: 'c1', date: '2026-10-07', archived: true }),
      tx({ amount: 50, amount_usd: 50, category_id: 'c1', date: '2026-09-07' }),
      tx({ amount: 70, amount_usd: 70, category_id: 'c1', date: '2026-09-08', ...gone }),
    ]
    const r = monthReport(txs, '2026-10')
    expect(r.totalUsd).toBe(30)
    expect(r.prevTotalUsd).toBe(50)
    expect(r.top).toHaveLength(2)
    const limit = { id: 'l1', deleted: false, category_id: 'c1', monthly_usd: 100 } as unknown as Limit
    expect(limitStatus(limit, txs, '2026-10').spentUsd).toBe(30)
  })

  it('contractStats', () => {
    const txs = [
      tx({ kind: 'income', amount: 1000, amount_usd: 1000, date: '2026-10-02' }),
      tx({ kind: 'income', amount: 500, amount_usd: 500, date: '2026-10-03', ...gone }),
      tx({ kind: 'expense', amount: 100, amount_usd: 100, date: '2026-10-04' }),
      tx({ kind: 'expense', amount: 400, amount_usd: 400, date: '2026-10-05', ...gone }),
    ]
    const s = settings({ contract_start_date: '2026-10-01', contract_end_date: '2026-10-31' })
    const r = contractStats(txs, s, '2026-10-10')
    expect(r.earnedUsd).toBe(1000)
    expect(r.savedThisMonthUsd).toBe(900)
  })
})
