import { describe, expect, it } from 'vitest'
import type { Transaction } from './types.ts'
import { purgeDue, RESTORE_MS, restorable, selectForWipe, wipeFrom } from './wipe.ts'

const TODAY = '2026-10-22'
const NOW = Date.parse('2026-10-22T10:00:00Z')
const HOUR = 60 * 60 * 1000

function tx(id: string, date: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id,
    kind: 'expense',
    amount: 10,
    currency: 'UAH',
    rate_usd: 0.025,
    amount_usd: 0.25,
    rate_pending: false,
    account_id: 'a1',
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: null,
    date,
    note: '',
    source: 'app',
    created_at: `${date}T12:00:00Z`,
    author: 'owner',
    archived: false,
    deleted: false,
    deleted_at: null,
    deleted_batch: null,
    ...patch,
  }
}

const dates = ['2026-09-22', '2026-09-23', '2026-10-16', '2026-10-22', '2026-10-23']
const set = dates.map((d) => tx(d, d))
const ids = (txs: Transaction[]) => txs.map((t) => t.id).sort()

describe('wipeFrom', () => {
  it('day → today, week → today-6, month → today-29, all → null', () => {
    expect(wipeFrom('day', TODAY)).toBe('2026-10-22')
    expect(wipeFrom('week', TODAY)).toBe('2026-10-16')
    expect(wipeFrom('month', TODAY)).toBe('2026-09-23')
    expect(wipeFrom('all', TODAY)).toBeNull()
  })
})

describe('selectForWipe', () => {
  it('takes the period inclusive and never a future date', () => {
    expect(ids(selectForWipe(set, 'month', 'expense', TODAY))).toEqual(['2026-09-23', '2026-10-16', '2026-10-22'])
    expect(ids(selectForWipe(set, 'week', 'expense', TODAY))).toEqual(['2026-10-16', '2026-10-22'])
    expect(ids(selectForWipe(set, 'day', 'expense', TODAY))).toEqual(['2026-10-22'])
    expect(ids(selectForWipe(set, 'all', 'expense', TODAY))).toEqual(['2026-09-22', '2026-09-23', '2026-10-16', '2026-10-22'])
  })

  it('an author limits the selection to that person (the second person deletes only her own)', () => {
    const two = [tx('mine', TODAY), tx('hers', TODAY, { author: 'partner' })]
    expect(selectForWipe(two, 'day', 'all', TODAY, 'partner').map((t) => t.id)).toEqual(['hers'])
    expect(selectForWipe(two, 'day', 'all', TODAY).map((t) => t.id)).toEqual(['mine', 'hers'])
  })

  it("kind 'income' takes only incomes, 'all' takes every kind", () => {
    const mixed = [
      tx('e', TODAY),
      tx('i', TODAY, { kind: 'income' }),
      tx('t', TODAY, { kind: 'transfer' }),
      tx('x', TODAY, { kind: 'exchange' }),
      tx('a', TODAY, { kind: 'adjustment' }),
    ]
    expect(ids(selectForWipe(mixed, 'day', 'income', TODAY))).toEqual(['i'])
    expect(ids(selectForWipe(mixed, 'day', 'expense', TODAY))).toEqual(['e'])
    expect(ids(selectForWipe(mixed, 'day', 'all', TODAY))).toEqual(['a', 'e', 'i', 't', 'x'])
  })

  it('deleted rows are not selected', () => {
    const rows = [
      tx('live', TODAY),
      tx('gone', TODAY, { deleted: true }),
      tx('bin', TODAY, { deleted_at: '2026-10-22T08:00:00Z', deleted_batch: 'b0' }),
    ]
    expect(ids(selectForWipe(rows, 'all', 'all', TODAY))).toEqual(['live'])
  })
})

describe('restorable', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString()

  it('true while the batch has rows deleted less than 24 h ago', () => {
    const rows = [{ deleted_at: at(23 * HOUR), deleted_batch: 'b1' }]
    expect(restorable(rows, 'b1', NOW)).toBe(true)
  })

  it('false after 24 h, for an unknown batch, or for a batch with no deleted rows (an import)', () => {
    expect(restorable([{ deleted_at: at(25 * HOUR), deleted_batch: 'b1' }], 'b1', NOW)).toBe(false)
    expect(restorable([{ deleted_at: at(HOUR), deleted_batch: 'b1' }], 'b2', NOW)).toBe(false)
    expect(restorable([{ deleted_at: null, deleted_batch: 'b1' }], 'b1', NOW)).toBe(false)
  })
})

describe('purgeDue', () => {
  it('lists rows whose deleted_at is older than 24 h', () => {
    const rows = [
      { id: 'old', deleted: false, deleted_at: new Date(NOW - 25 * HOUR).toISOString(), deleted_batch: 'b' },
      { id: 'fresh', deleted: false, deleted_at: new Date(NOW - 23 * HOUR).toISOString(), deleted_batch: 'b' },
      { id: 'live', deleted: false, deleted_at: null, deleted_batch: null },
      { id: 'final', deleted: true, deleted_at: new Date(NOW - 48 * HOUR).toISOString(), deleted_batch: 'b' },
    ]
    expect(purgeDue(rows, NOW)).toEqual(['old'])
  })

  it('RESTORE_MS is 24 hours', () => {
    expect(RESTORE_MS).toBe(24 * HOUR)
  })
})
