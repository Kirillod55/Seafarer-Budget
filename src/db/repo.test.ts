import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { balances } from '@shared/calc.ts'
import { parseCsv, planImport, toCsv, type ImportRow } from '@shared/csv.ts'
import type { Account, Category, FxRate, Goal, Limit, Settings, Transaction } from '@shared/types.ts'
import { createDb, type LocalDb } from './local.ts'
import { createRepo, type NewTransaction, type Repo } from './repo.ts'

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

  // accounts (like settings and goal_moves) have no deleted_at on the server: their removal stays final
  it('remove marks an account deleted and dirty', async () => {
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

describe('Dexie upgrade', () => {
  it('v1 database upgrades to v2 with defaults', async () => {
    const name = `repo-test-upgrade-${++n}`
    const v1 = new Dexie(name)
    v1.version(1).stores({
      settings: 'id, dirty, rev',
      accounts: 'id, dirty, rev',
      categories: 'id, dirty, rev',
      transactions: 'id, dirty, rev',
      goals: 'id, dirty, rev',
      goal_moves: 'id, dirty, rev',
      limits: 'id, dirty, rev',
      fx_rates: '[date+currency]',
      meta: 'key',
    })
    await v1.table('transactions').put({ id: 't1', deleted: false, dirty: 0, rev: 5, kind: 'expense', amount: 80, currency: 'UAH', date: '2026-10-01', note: 'кофе' })
    await v1.table('goals').put({ id: 'g1', deleted: false, dirty: 0, name: 'Отпуск', target_usd: 1000, deadline: null, archived: false })
    await v1.table('goal_moves').put({ id: 'm1', deleted: false, dirty: 0, goal_id: 'g1', amount_usd: 50, date: '2026-10-02', note: '' })
    await v1.table('categories').put({ id: 'c1', deleted: false, dirty: 0, name: 'Продукты', kind: 'expense', icon: '🛒', keywords: [], archived: false, sort: 0 })
    await v1.table('limits').put({ id: 'l1', deleted: false, dirty: 0, category_id: 'c1', monthly_usd: 100 })
    await v1.table('settings').put({ id: 's1', deleted: false, dirty: 0, base_currency: 'USD', timezone: 'Europe/Kyiv' })
    v1.close()

    const upgraded = createDb(name)
    try {
      expect(await upgraded.transactions.get('t1')).toMatchObject({
        author: 'owner', archived: false, deleted_at: null, deleted_batch: null, amount: 80, rev: 5,
      })
      expect(await upgraded.goals.get('g1')).toMatchObject({ deleted_at: null, deleted_batch: null })
      expect(await upgraded.limits.get('l1')).toMatchObject({ deleted_at: null, deleted_batch: null })
      expect(await upgraded.categories.get('c1')).toMatchObject({ deleted_at: null, deleted_batch: null, color: null, glyph: null })
      expect(await upgraded.goal_moves.get('m1')).toMatchObject({
        author: 'owner', source: 'app', created_at: '2026-10-02T12:00:00.000Z',
      })
      expect(await upgraded.settings.get('s1')).toMatchObject({
        base_currency: 'USD', reserve_usd: 0, partner_name: null, partner_seen_at: null, remind_after_days: 2,
        last_reminder_at: null, keepalive_at: null, daily_summary_owner: false, daily_summary_partner: false,
      })
    } finally {
      upgraded.close()
      await Dexie.delete(name)
    }
  })
})

/* ---------- 1.1: soft delete, wipe, archive, import ---------- */

const NOW_ISO = '2026-10-21T10:00:00.000Z'
const imp = (patch: Partial<ImportRow>): ImportRow => ({
  line: 2,
  date: '2026-10-20',
  kind: 'expense',
  amount: 50,
  currency: 'UAH',
  category: 'Продукты',
  account: '',
  note: '',
  author: 'owner',
  toAccount: '',
  toAmount: null,
  toCurrency: null,
  ...patch,
})

async function synced(id: string, rev = 3) {
  await db.transactions.update(id, { dirty: 0, rev })
}

describe('remove (soft) and restore', () => {
  it('remove is soft and restorable', async () => {
    const tx = await repo.addTransaction(baseTx)
    await synced(tx.id)
    const batch = (await repo.remove('transactions', tx.id))!
    expect(batch).toEqual(expect.any(String))
    expect(await db.transactions.get(tx.id)).toMatchObject({ deleted: false, deleted_at: NOW_ISO, deleted_batch: batch, dirty: 1, rev: 3 })

    await synced(tx.id, 4)
    expect(await repo.restore(batch)).toBe(1)
    expect(await db.transactions.get(tx.id)).toMatchObject({ deleted: false, deleted_at: null, deleted_batch: null, dirty: 1, rev: 4 })
  })

  it('remove returns null for a missing id and for a table without a bin', async () => {
    expect(await repo.remove('transactions', 'nope')).toBeNull()
    await repo.put<Account>('accounts', { id: 'a1', name: 'Карта' })
    expect(await repo.remove('accounts', 'a1')).toBeNull()
  })

  // M2 (final review): returning the wipe's batch would let «Отменить» bring back the whole wipe
  it('removing a row already in the bin returns null and writes nothing; it stays in its own batch', async () => {
    const tx = await repo.addTransaction(baseTx)
    await repo.addTransaction({ ...baseTx, note: 'обед' })
    const { batch } = await repo.wipe('day', 'all')
    await synced(tx.id)
    onChange.mockClear()
    expect(await repo.remove('transactions', tx.id)).toBeNull()
    expect(await db.transactions.get(tx.id)).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch, dirty: 0 })
    expect(onChange).not.toHaveBeenCalled()
  })

  // M3 (final review): an explicit undefined must not wipe the defaults
  it('addTransaction fills author and archived even when they are passed as undefined', async () => {
    const tx = await repo.addTransaction({ ...baseTx, author: undefined, archived: undefined })
    expect(tx).toMatchObject({ author: 'owner', archived: false })
    expect(await db.transactions.get(tx.id)).toMatchObject({ author: 'owner', archived: false })
  })

  it('goals, limits and categories are removed softly too', async () => {
    await repo.put<Goal>('goals', { id: 'g1', name: 'Отпуск', target_usd: 1000, deadline: null, archived: false, deleted_at: null, deleted_batch: null })
    const batch = await repo.remove('goals', 'g1')
    expect(await db.goals.get('g1')).toMatchObject({ deleted: false, deleted_at: NOW_ISO, deleted_batch: batch })
  })

  it("wipe('day','expense') marks only today's live expenses and returns the count", async () => {
    const a = await repo.addTransaction(baseTx)
    const b = await repo.addTransaction({ ...baseTx, note: 'обед' })
    const yesterday = await repo.addTransaction({ ...baseTx, date: '2026-10-20' })
    const income = await repo.addTransaction({ ...baseTx, kind: 'income' })
    const future = await repo.addTransaction({ ...baseTx, date: '2026-10-22' })
    const gone = await repo.addTransaction(baseTx)
    for (const t of [a, b, yesterday, income, future, gone]) await synced(t.id)
    await db.transactions.update(gone.id, { deleted: true })
    onChange.mockClear()

    const { batch, count } = await repo.wipe('day', 'expense')
    expect(count).toBe(2)
    for (const t of [a, b]) {
      expect(await db.transactions.get(t.id)).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch, dirty: 1 })
    }
    for (const t of [yesterday, income, future, gone]) {
      expect(await db.transactions.get(t.id)).toMatchObject({ deleted_at: null, dirty: 0 })
    }
    expect(onChange).toHaveBeenCalled()
  })

  it('restore after one row was purged: the rest come back, the purged one stays deleted (Review Focus 5)', async () => {
    const a = await repo.addTransaction(baseTx)
    const b = await repo.addTransaction(baseTx)
    const { batch } = await repo.wipe('day', 'all')
    // the daily check made `a` final meanwhile (pulled from the server)
    await db.transactions.update(a.id, { deleted: true, dirty: 0, rev: 9 })
    await synced(b.id, 8)

    expect(await repo.restore(batch)).toBe(1)
    expect(await db.transactions.get(a.id)).toMatchObject({ deleted: true, deleted_at: NOW_ISO, deleted_batch: batch, dirty: 0, rev: 9 })
    expect(await db.transactions.get(b.id)).toMatchObject({ deleted: false, deleted_at: null, dirty: 1 })
  })

  it('restore of an unknown batch changes nothing', async () => {
    await repo.addTransaction(baseTx)
    expect(await repo.restore('nope')).toBe(0)
  })
})

describe('removeCategory', () => {
  async function setup() {
    await repo.initDefaults('single', [])
    const cats = await db.categories.toArray()
    const byName = (name: string) => cats.find((c) => c.name === name)!
    return { cafe: byName('Кафе и рестораны'), other: byName('Прочее'), salary: byName('Зарплата'), otherIncome: byName('Прочий доход'), transport: byName('Транспорт и такси') }
  }

  it('bins the category and its limit in one batch and moves its records to «Прочее»; restore brings all of it back', async () => {
    const { cafe, other, transport } = await setup()
    const a = await repo.addTransaction({ ...baseTx, category_id: cafe.id })
    const b = await repo.addTransaction({ ...baseTx, category_id: cafe.id, archived: true })
    const elsewhere = await repo.addTransaction({ ...baseTx, category_id: transport.id })
    await repo.put<Limit>('limits', { id: 'lim-cafe', category_id: cafe.id, monthly_usd: 100, deleted_at: null, deleted_batch: null })
    await repo.put<Limit>('limits', { id: 'lim-taxi', category_id: transport.id, monthly_usd: 50, deleted_at: null, deleted_batch: null })
    onChange.mockClear()

    const batch = (await repo.removeCategory(cafe.id))!
    expect(batch).toEqual(expect.any(String))
    expect(await db.categories.get(cafe.id)).toMatchObject({ deleted: false, deleted_at: NOW_ISO, deleted_batch: batch, dirty: 1 })
    expect(await db.limits.get('lim-cafe')).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch, dirty: 1 })
    expect(await db.limits.get('lim-taxi')).toMatchObject({ deleted_at: null })
    for (const t of [a, b]) expect(await db.transactions.get(t.id)).toMatchObject({ category_id: other.id, deleted_at: null, dirty: 1 })
    expect((await db.transactions.get(b.id))!.archived).toBe(true)
    expect((await db.transactions.get(elsewhere.id))!.category_id).toBe(transport.id)
    expect(onChange).toHaveBeenCalled()

    expect(await repo.restore(batch)).toBe(4)
    expect(await db.categories.get(cafe.id)).toMatchObject({ deleted_at: null, deleted_batch: null })
    expect(await db.limits.get('lim-cafe')).toMatchObject({ deleted_at: null, deleted_batch: null })
    for (const t of [a, b]) expect(await db.transactions.get(t.id)).toMatchObject({ category_id: cafe.id, dirty: 1 })
    // the move is forgotten: a second restore changes nothing
    expect(await repo.restore(batch)).toBe(0)
  })

  it('an income category goes to «Прочий доход»', async () => {
    const { salary, otherIncome } = await setup()
    const t = await repo.addTransaction({ ...baseTx, kind: 'income', category_id: salary.id })
    await repo.removeCategory(salary.id)
    expect((await db.transactions.get(t.id))!.category_id).toBe(otherIncome.id)
  })

  it('restore leaves a record that was moved to another category meanwhile where the user put it', async () => {
    const { cafe, transport } = await setup()
    const t = await repo.addTransaction({ ...baseTx, category_id: cafe.id })
    const batch = (await repo.removeCategory(cafe.id))!
    await repo.updateTransaction(t.id, { category_id: transport.id })
    await repo.restore(batch)
    expect((await db.transactions.get(t.id))!.category_id).toBe(transport.id)
  })

  it('«Прочее», «Прочий доход», a missing and a binned category are not removed', async () => {
    const { cafe, other, otherIncome } = await setup()
    expect(await repo.removeCategory(other.id)).toBeNull()
    expect(await repo.removeCategory(otherIncome.id)).toBeNull()
    expect(await repo.removeCategory('nope')).toBeNull()
    expect(await repo.removeCategory(cafe.id)).toEqual(expect.any(String))
    expect(await repo.removeCategory(cafe.id)).toBeNull()
    expect(await db.categories.get(other.id)).toMatchObject({ deleted_at: null })
  })
})

describe('wipeAll', () => {
  it('marks records, goals, limits and own categories; keeps settings, accounts and standard categories', async () => {
    await repo.initDefaults('single', [{ currency: 'UAH', amount: 5000 }])
    const own = await repo.put<Category>('categories', {
      name: 'Рыбалка', kind: 'expense', icon: '🎣', keywords: [], archived: false, sort: 20,
      color: null, glyph: null, deleted_at: null, deleted_batch: null,
    })
    await repo.addTransaction(baseTx)
    await repo.put<Goal>('goals', { id: 'g1', name: 'Отпуск', target_usd: 1000, deadline: null, archived: false, deleted_at: null, deleted_batch: null })
    await repo.put<Limit>('limits', { id: 'l1', category_id: own.id, monthly_usd: 100, deleted_at: null, deleted_batch: null })
    for (const t of ['settings', 'accounts', 'categories', 'transactions', 'goals', 'limits'] as const) {
      await db.syncTable(t).toCollection().modify({ dirty: 0 })
    }

    const { batch, count } = await repo.wipeAll()
    expect(count).toBe(5) // 2 records (opening balance + coffee), 1 goal, 1 limit, 1 own category

    const settings = await db.settings.toArray()
    expect(settings[0]).toMatchObject({ dirty: 0, deleted: false })
    expect(settings[0]).not.toHaveProperty('deleted_at')
    expect((await db.accounts.toArray()).every((a) => a.dirty === 0 && !('deleted_at' in a))).toBe(true)
    const standard = (await db.categories.toArray()).filter((c) => c.id !== own.id)
    expect(standard).toHaveLength(15)
    expect(standard.every((c) => c.deleted_at === null && c.dirty === 0)).toBe(true)

    expect(await db.categories.get(own.id)).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch, dirty: 1 })
    expect(await db.goals.get('g1')).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch })
    expect(await db.limits.get('l1')).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch })
    expect((await db.transactions.toArray()).every((t) => t.deleted_batch === batch)).toBe(true)

    expect(await repo.restore(batch)).toBe(5)
    expect(await db.goals.get('g1')).toMatchObject({ deleted_at: null })
  })
})

describe('setArchived', () => {
  it('archives and unarchives a record, marking it dirty', async () => {
    const tx = await repo.addTransaction(baseTx)
    await synced(tx.id)
    onChange.mockClear()
    await repo.setArchived(tx.id, true)
    expect(await db.transactions.get(tx.id)).toMatchObject({ archived: true, dirty: 1, rev: 3 })
    expect(onChange).toHaveBeenCalledTimes(1)
    await repo.setArchived(tx.id, false)
    expect(await db.transactions.get(tx.id)).toMatchObject({ archived: false })
  })
})

describe('importRows / markBatchDeleted', () => {
  it('imports with the batch mark, resolves categories and accounts; undo removes exactly the import', async () => {
    await repo.initDefaults('multi', [
      { currency: 'UAH', amount: 100, accountName: 'Моно' },
      { currency: 'USD', amount: 50, accountName: 'Наличные' },
    ])
    const accounts = await db.accounts.toArray()
    const mono = accounts.find((a) => a.name === 'Моно')!
    const cash = accounts.find((a) => a.name === 'Наличные')!
    const categories = await db.categories.toArray()
    const food = categories.find((c) => c.name === 'Продукты')!
    const salary = categories.find((c) => c.name === 'Зарплата')!
    const before = (await db.transactions.toArray()).map((t) => t.id)

    const { batch, count } = await repo.importRows(
      [
        imp({ line: 2, note: 'атб' }),
        imp({ line: 3, kind: 'income', category: 'Зарплата', amount: 1200, currency: 'USD', account: 'Наличные', author: 'partner' }),
        imp({ line: 4, category: 'Рыбалка', account: 'Нет такого', note: 'удочка' }),
      ],
      { createCategories: true },
    )
    expect(count).toBe(3)
    const imported = (await db.transactions.toArray()).filter((t) => !before.includes(t.id))
    expect(imported).toHaveLength(3)
    expect(imported.every((t) => t.deleted_batch === batch && t.deleted_at === null && t.dirty === 1 && t.source === 'app')).toBe(true)
    const byNote = (note: string) => imported.find((t) => t.note === note)!
    expect(byNote('атб')).toMatchObject({ category_id: food.id, account_id: mono.id, author: 'owner', date: '2026-10-20', amount: 50 })
    const income = imported.find((t) => t.kind === 'income')!
    expect(income).toMatchObject({ category_id: salary.id, account_id: cash.id, author: 'partner', amount_usd: 1200 })
    const fishing = (await db.categories.toArray()).find((c) => c.name === 'Рыбалка')!
    expect(fishing).toMatchObject({ kind: 'expense', deleted_batch: batch, deleted_at: null, dirty: 1 })
    expect(byNote('удочка')).toMatchObject({ category_id: fishing.id, account_id: mono.id })

    expect(await repo.markBatchDeleted(batch)).toBe(4) // 3 records + the category the import created
    for (const t of await db.transactions.toArray()) {
      if (before.includes(t.id)) expect(t.deleted_at).toBeNull()
      else expect(t).toMatchObject({ deleted_at: NOW_ISO, deleted_batch: batch })
    }
    expect(await db.categories.get(fishing.id)).toMatchObject({ deleted_at: NOW_ISO })
    expect((await db.categories.toArray()).filter((c) => c.deleted_at !== null)).toHaveLength(1)
  })

  it('without createCategories an unknown or empty category goes to «Прочее» / «Прочий доход»', async () => {
    await repo.initDefaults('single', [])
    const categories = await db.categories.toArray()
    const other = categories.find((c) => c.name === 'Прочее')!
    const otherIncome = categories.find((c) => c.name === 'Прочий доход')!
    await repo.importRows(
      [imp({ category: 'Рыбалка', note: 'e' }), imp({ kind: 'income', category: 'Подработка', note: 'i' }), imp({ category: '', note: 'empty' })],
      { createCategories: false },
    )
    const txs = await db.transactions.toArray()
    expect(txs.find((t) => t.note === 'e')!.category_id).toBe(other.id)
    expect(txs.find((t) => t.note === 'i')!.category_id).toBe(otherIncome.id)
    expect(txs.find((t) => t.note === 'empty')!.category_id).toBe(other.id)
    expect(await db.categories.count()).toBe(15)
  })

  it('imports corrections, transfers and exchanges with their accounts; categories match case-insensitively', async () => {
    await repo.initDefaults('multi', [
      { currency: 'UAH', amount: 0, accountName: 'Моно' },
      { currency: 'USD', amount: 0, accountName: 'Наличные' },
    ])
    const accounts = await db.accounts.toArray()
    const mono = accounts.find((a) => a.name === 'Моно')!
    const cash = accounts.find((a) => a.name === 'Наличные')!
    const food = (await db.categories.toArray()).find((c) => c.name === 'Продукты')!
    await repo.importRows(
      [
        imp({ note: 'e', category: 'продукты' }),
        imp({ note: 'c', kind: 'adjustment', amount: -12.5, category: '', account: 'Наличные' }),
        imp({ note: 't', kind: 'transfer', amount: 100, category: '', account: 'Моно', toAccount: 'Наличные' }),
        imp({ note: 'x', kind: 'exchange', amount: 415, category: '', account: 'Наличные', toAmount: 10, toCurrency: 'USD' }),
        imp({ note: 'y', kind: 'exchange', amount: 415, category: '', account: 'Моно', toAccount: 'Наличные', toAmount: 10, toCurrency: 'USD' }),
      ],
      { createCategories: false },
    )
    const txs = await db.transactions.toArray()
    const by = (note: string) => txs.find((t) => t.note === note)!
    expect(by('e')).toMatchObject({ category_id: food.id, account_id: mono.id })
    expect(by('c')).toMatchObject({ kind: 'adjustment', amount: -12.5, category_id: null, account_id: cash.id, to_account_id: null })
    expect(by('t')).toMatchObject({ kind: 'transfer', amount: 100, category_id: null, account_id: mono.id, to_account_id: cash.id, to_amount: null, to_currency: null })
    // an exchange without «Счёт куда» stays on its account (as the app saves it)
    expect(by('x')).toMatchObject({ kind: 'exchange', category_id: null, account_id: cash.id, to_account_id: cash.id, to_amount: 10, to_currency: 'USD' })
    expect(by('y')).toMatchObject({ account_id: mono.id, to_account_id: cash.id })
  })

  // I5 (final review): the CSV is the disaster-recovery copy (spec §10)
  it('full backup: export, then import into a book with the same accounts and no records, gives the same balances', async () => {
    await repo.initDefaults('multi', [
      { currency: 'UAH', amount: 10000, accountName: 'Моно' },
      { currency: 'USD', amount: 500.5, accountName: 'Наличные' },
    ])
    const accounts = await db.accounts.toArray()
    const mono = accounts.find((a) => a.name === 'Моно')!.id
    const cash = accounts.find((a) => a.name === 'Наличные')!.id
    const categories = await db.categories.toArray()
    const cat = (name: string) => categories.find((c) => c.name === name)!.id
    const add = (p: Partial<NewTransaction>) => repo.addTransaction({ ...baseTx, account_id: mono, ...p })
    await add({ category_id: cat('Продукты'), amount: 0.99, note: 'жвачка' })
    await add({ category_id: cat('Продукты'), amount: 1200.5, author: 'partner', note: 'Атб; "акция"' })
    await add({ category_id: cat('Продукты'), amount: 1200.5, author: 'partner', note: 'Атб; "акция"' }) // a true double
    await add({ kind: 'income', category_id: cat('Зарплата'), amount: 3000, currency: 'USD', account_id: cash, note: 'аванс' })
    await add({ kind: 'adjustment', amount: -150.25, note: 'сверка' })
    await add({ kind: 'transfer', amount: 2000, to_account_id: cash, note: 'в наличные', author: 'partner' })
    await add({ kind: 'exchange', amount: 100, currency: 'USD', account_id: cash, to_account_id: cash, to_amount: 4150, to_currency: 'UAH', note: '' })
    await add({ kind: 'exchange', amount: 415, to_account_id: null, to_amount: 10.01, to_currency: 'USD', note: 'старый обмен' })
    const binned = await add({ amount: 999, note: 'в корзине' })
    await repo.remove('transactions', binned.id)

    const txs = await db.transactions.toArray()
    const { rows, errors } = parseCsv(toCsv(txs, categories, accounts, 'Маша'), 'Маша')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(txs.length - 1)
    // the same book: nothing is new
    expect(planImport(rows, txs, categories, accounts).fresh).toEqual([])

    // a book with the same accounts and no records
    const db2 = createDb(`repo-test-${++n}`)
    let ids2 = 0
    const repo2 = createRepo(db2, { now: () => new Date('2026-10-21T10:00:00Z'), uuid: () => `b-${++ids2}`, onChange: () => {} })
    try {
      await repo2.initDefaults('multi', [
        { currency: 'UAH', amount: 0, accountName: 'Моно' },
        { currency: 'USD', amount: 0, accountName: 'Наличные' },
      ])
      expect(await db2.transactions.count()).toBe(0)
      const accounts2 = await db2.accounts.toArray()
      const plan = planImport(rows, [], await db2.categories.toArray(), accounts2)
      expect(plan).toMatchObject({ duplicates: [], unknownCategories: [], unknownAccounts: [] })
      await repo2.importRows(plan.fresh, { createCategories: false })
      const txs2 = await db2.transactions.toArray()
      expect(balances(txs2)).toEqual(balances(txs))
      for (const name of ['Моно', 'Наличные']) {
        const before = balances(txs, accounts.find((a) => a.name === name)!.id)
        const after = balances(txs2, accounts2.find((a) => a.name === name)!.id)
        expect(after, name).toEqual(before)
      }
      expect(txs2.filter((t) => t.author === 'partner')).toHaveLength(3)
    } finally {
      await db2.delete()
    }
  })
})
