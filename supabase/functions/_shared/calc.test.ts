import { describe, expect, it } from 'vitest'
import {
  allowance,
  balances,
  balanceUsd,
  contractStats,
  goalProgress,
  limitCrossing,
  limitStatus,
  monthReport,
  reservedUsd,
} from './calc.ts'
import { addDays } from './dates.ts'
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
    ...p,
  }
}

function move(p: Partial<GoalMove>): GoalMove {
  return { id: `m${++seq}`, deleted: false, goal_id: 'g1', amount_usd: 0, date: '2026-10-01', note: '', ...p }
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

describe('allowance', () => {
  it('splits the free money until next contract + salary lag', () => {
    const a = allowance(
      3040,
      settings({ next_contract_date: '2026-11-20', salary_lag_days: 30 }),
      '2026-10-21',
    )
    expect(a).toEqual({ status: 'ok', days: 60, perDay: 50.67, perMonth: 1540.27 })
  })

  it('no_date without next contract date', () => {
    expect(allowance(3040, settings(), '2026-10-21')).toEqual({ status: 'no_date' })
  })

  it('expired when date + lag is not after today', () => {
    expect(
      allowance(100, settings({ next_contract_date: '2026-09-20', salary_lag_days: 30 }), '2026-10-21'),
    ).toEqual({ status: 'expired' })
    expect(
      allowance(100, settings({ next_contract_date: '2026-10-01', salary_lag_days: 20 }), '2026-10-21'),
    ).toEqual({ status: 'expired' })
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
  const goal: Goal = { id: 'g1', deleted: false, name: 'Car', target_usd: 1000, deadline: null, archived: false }

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
  const limit: Limit = { id: 'l1', deleted: false, category_id: 'c1', monthly_usd: 100 }
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
