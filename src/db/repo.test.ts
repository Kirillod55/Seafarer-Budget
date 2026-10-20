import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, FxRate, Settings, Transaction } from '@shared/types.ts'
import { createDb, type LocalDb } from './local.ts'
import { createRepo, type Repo } from './repo.ts'

let n = 0
let db: LocalDb
let repo: Repo
let ids: number
const onChange = vi.fn()

const TODAY = '2026-10-21'
const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

beforeEach(() => {
  db = createDb(`repo-test-${++n}`)
  ids = 0
  onChange.mockClear()
  repo = createRepo(db, {
    now: () => new Date('2026-10-21T10:00:00Z'),
    uuid: () => `id-${++ids}`,
    onChange,
  })
})

afterEach(async () => {
  await db.delete()
})

const baseTx = {
  kind: 'expense' as const,
  amount: 80,
  currency: 'UAH',
  account_id: 'acc',
  to_account_id: null,
  to_amount: null,
  to_currency: null,
  category_id: null,
  date: TODAY,
  note: 'кофе',
  source: 'app' as const,
}

describe('put / remove', () => {
  it('assigns an id, deleted=false and dirty=1, and notifies', async () => {
    const acc = await repo.put<Account>('accounts', { name: 'Карта', aliases: [], is_default: false, archived: false, sort: 0 })
    expect(acc.id).toBe('id-1')
    const stored = await db.accounts.get(acc.id)
    expect(stored).toMatchObject({ name: 'Карта', deleted: false, dirty: 1 })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps a given id and merges into the existing row', async () => {
    await repo.put<Account>('accounts', { id: 'a1', name: 'Карта', aliases: [], is_default: false, archived: false, sort: 0 })
    await db.accounts.update('a1', { dirty: 0, rev: 7 })
    await repo.put<Account>('accounts', { id: 'a1', name: 'Новая' })
    const stored = await db.accounts.get('a1')
    expect(stored).toMatchObject({ name: 'Новая', sort: 0, dirty: 1, rev: 7, deleted: false })
  })

  it('remove marks the row deleted and dirty', async () => {
    await repo.put<Account>('accounts', { id: 'a1', name: 'Карта' })
    await db.accounts.update('a1', { dirty: 0 })
    await repo.remove('accounts', 'a1')
    expect(await db.accounts.get('a1')).toMatchObject({ deleted: true, dirty: 1 })
  })
})

describe('addTransaction', () => {
  it('uses the exact rate on the date: 80 UAH -> 1.94 USD, not pending', async () => {
    await db.fx_rates.bulkPut([rate(TODAY, 'UAH', 1), rate(TODAY, 'USD', 41.25)])
    const tx = await repo.addTransaction(baseTx)
    expect(tx.amount_usd).toBe(1.94)
    expect(tx.rate_pending).toBe(false)
    expect(tx.deleted).toBe(false)
    expect(tx.created_at).toBe('2026-10-21T10:00:00.000Z')
    expect(await db.transactions.get(tx.id)).toMatchObject({ dirty: 1, amount_usd: 1.94 })
  })

  it('falls back to the nearest earlier rate and marks pending', async () => {
    await db.fx_rates.bulkPut([rate('2026-10-19', 'UAH', 1), rate('2026-10-19', 'USD', 40)])
    const tx = await repo.addTransaction(baseTx)
    expect(tx.rate_usd).toBeCloseTo(1 / 40, 10)
    expect(tx.amount_usd).toBe(2)
    expect(tx.rate_pending).toBe(true)
  })

  it('stores zeros and pending when no rate is known at all', async () => {
    const tx = await repo.addTransaction(baseTx)
    expect(tx).toMatchObject({ rate_usd: 0, amount_usd: 0, rate_pending: true })
  })

  it('USD needs no rates', async () => {
    const tx = await repo.addTransaction({ ...baseTx, currency: 'USD', amount: 12.5 })
    expect(tx).toMatchObject({ rate_usd: 1, amount_usd: 12.5, rate_pending: false })
  })
})

describe('updateTransaction', () => {
  it('recomputes the rate and amount_usd from the edited amount/currency/date and marks dirty', async () => {
    await db.fx_rates.bulkPut([rate(TODAY, 'UAH', 1), rate(TODAY, 'USD', 40), rate('2026-10-10', 'UAH', 1), rate('2026-10-10', 'USD', 50)])
    const tx = await repo.addTransaction(baseTx)
    expect(tx.amount_usd).toBe(2)
    await db.transactions.update(tx.id, { dirty: 0, rev: 3 })
    onChange.mockClear()

    const updated = await repo.updateTransaction(tx.id, { amount: 120 })
    expect(updated).toMatchObject({ id: tx.id, amount: 120, amount_usd: 3, rate_pending: false })
    expect(await db.transactions.get(tx.id)).toMatchObject({ amount: 120, amount_usd: 3, dirty: 1, rev: 3, note: 'кофе' })
    expect(onChange).toHaveBeenCalledTimes(1)

    const moved = await repo.updateTransaction(tx.id, { date: '2026-10-10', currency: 'USD', amount: 10 })
    expect(moved).toMatchObject({ currency: 'USD', rate_usd: 1, amount_usd: 10, date: '2026-10-10' })
  })

  it('fails loudly for an unknown id', async () => {
    await expect(repo.updateTransaction('nope', { amount: 1 })).rejects.toThrow()
  })
})

describe('initDefaults', () => {
  it('single mode: one default account, 15 categories, one adjustment, settings', async () => {
    await repo.initDefaults('single', [{ currency: 'UAH', amount: 5000 }])
    const accounts = await db.accounts.toArray()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ name: 'Основной', is_default: true, deleted: false, dirty: 1 })
    expect(await db.categories.count()).toBe(15)
    const txs = await db.transactions.toArray()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      kind: 'adjustment',
      amount: 5000,
      currency: 'UAH',
      category_id: null,
      note: 'Начальный остаток',
      source: 'app',
      date: TODAY,
      account_id: accounts[0].id,
    })
    const settings = await db.settings.toArray()
    expect(settings).toHaveLength(1)
    expect((settings[0] as Settings).accounts_mode).toBe('single')
    expect(settings[0].dirty).toBe(1)
  })

  it('skips zero opening amounts', async () => {
    await repo.initDefaults('single', [
      { currency: 'UAH', amount: 0 },
      { currency: 'USD', amount: 10 },
    ])
    expect(await db.transactions.count()).toBe(1)
  })

  it('multi mode: one account per distinct name in order, first is default', async () => {
    await repo.initDefaults('multi', [
      { currency: 'UAH', amount: 100, accountName: 'Моно' },
      { currency: 'USD', amount: 50, accountName: 'Наличные' },
      { currency: 'EUR', amount: 20, accountName: 'Моно' },
    ])
    const accounts = (await db.accounts.toArray()) as Account[]
    expect(accounts.map((a) => a.name).sort()).toEqual(['Моно', 'Наличные'])
    const mono = accounts.find((a) => a.name === 'Моно')!
    const cash = accounts.find((a) => a.name === 'Наличные')!
    expect(mono).toMatchObject({ is_default: true, sort: 0 })
    expect(cash).toMatchObject({ is_default: false, sort: 1 })
    const txs = (await db.transactions.toArray()) as Transaction[]
    expect(txs).toHaveLength(3)
    expect(txs.filter((t) => t.account_id === mono.id)).toHaveLength(2)
    expect((await db.settings.toArray())[0]).toMatchObject({ accounts_mode: 'multi' })
  })

  it('multi mode: unnamed entries go to Основной, created as default when first', async () => {
    await repo.initDefaults('multi', [
      { currency: 'UAH', amount: 100 },
      { currency: 'USD', amount: 50, accountName: 'Наличные' },
    ])
    const accounts = (await db.accounts.toArray()) as Account[]
    expect(accounts.map((a) => a.name)).toEqual(expect.arrayContaining(['Основной', 'Наличные']))
    expect(accounts).toHaveLength(2)
    expect(accounts.find((a) => a.name === 'Основной')!.is_default).toBe(true)
    expect(accounts.find((a) => a.name === 'Наличные')!.is_default).toBe(false)
  })

  it('multi mode with no entries still creates a default account', async () => {
    await repo.initDefaults('multi', [])
    const accounts = (await db.accounts.toArray()) as Account[]
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ name: 'Основной', is_default: true })
  })
})
