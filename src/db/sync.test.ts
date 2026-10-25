import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, FxRate, Goal, SyncTable, Transaction } from '@shared/types.ts'
import { createDb, type LocalDb } from './local.ts'
import { createRepo, type Repo } from './repo.ts'
import { createSync, RowRejectedError, type RatePatch, type Remote } from './sync.ts'

class FakeRemote implements Remote {
  tables = new Map<SyncTable, Map<string, Record<string, unknown>>>()
  nextRev = 1
  failPush = false
  failPull = false
  fx: Record<string, FxRate[]> = {}
  fxCalls: string[] = []
  fxCurrencies: string[][] = []
  pushLog: object[] = []
  attempted: string[] = []
  patchLog: RatePatch[][] = []
  /** id -> message: the server refuses any batch containing this row (an upsert is all-or-nothing) */
  reject = new Map<string, string>()

  t(table: SyncTable) {
    if (!this.tables.has(table)) this.tables.set(table, new Map())
    return this.tables.get(table)!
  }
  async push(table: SyncTable, rows: object[]) {
    if (this.failPush) throw new Error('network down')
    for (const r of rows) this.attempted.push((r as { id: string }).id)
    const bad = rows.find((r) => this.reject.has((r as { id: string }).id))
    if (bad) throw new RowRejectedError(this.reject.get((bad as { id: string }).id)!)
    return rows.map((r) => {
      this.pushLog.push(r)
      const row = r as { id: string }
      const rev = this.nextRev++
      this.t(table).set(row.id, { ...r, rev })
      return { id: row.id, rev }
    })
  }
  async pull(table: SyncTable, sinceRev: number) {
    if (this.failPull) throw new Error('network down')
    return [...this.t(table).values()]
      .filter((r) => (r.rev as number) > sinceRev)
      .sort((a, b) => (a.rev as number) - (b.rev as number))
  }
  async fxRates(date: string, currencies: string[]) {
    this.fxCalls.push(date)
    this.fxCurrencies.push(currencies)
    return this.fx[date] ?? []
  }
  // like update(...).eq('id', id).eq('rate_pending', true): only the rate columns, only while still pending
  async patchRates(rows: RatePatch[]) {
    this.patchLog.push(rows)
    for (const p of rows) {
      const row = this.t('transactions').get(p.id)
      if (!row || row.rate_pending !== true) continue
      this.t('transactions').set(p.id, {
        ...row,
        rate_usd: p.rate_usd,
        amount_usd: p.amount_usd,
        rate_pending: false,
        rev: this.nextRev++,
      })
    }
  }
  // a row written from outside the app (the Telegram bot); explicit rev allowed
  seed(table: SyncTable, row: Record<string, unknown>, rev?: number) {
    const r = rev ?? this.nextRev++
    if (rev !== undefined) this.nextRev = Math.max(this.nextRev, rev + 1)
    this.t(table).set(row.id as string, { ...row, rev: r })
  }
}

let n = 0
let dbs: LocalDb[] = []
let remote: FakeRemote

function device(): { db: LocalDb; repo: Repo; sync: ReturnType<typeof createSync> } {
  const db = createDb(`sync-test-${++n}`)
  dbs.push(db)
  let u = 0
  const repo = createRepo(db, {
    now: () => new Date('2026-10-21T10:00:00Z'),
    uuid: () => `d${n}-${++u}`,
    onChange: () => {},
  })
  return { db, repo, sync: createSync(db, remote) }
}

beforeEach(() => {
  remote = new FakeRemote()
  dbs = []
})
afterEach(async () => {
  await Promise.all(dbs.map((d) => d.delete()))
})

const acc = { name: 'Карта', aliases: [], is_default: true, archived: false, sort: 0 }
const botTx = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'expense',
  amount: 100,
  currency: 'USD',
  rate_usd: 1,
  amount_usd: 100,
  rate_pending: false,
  account_id: 'a',
  to_account_id: null,
  to_amount: null,
  to_currency: null,
  category_id: null,
  date: '2026-10-20',
  note: 'bot',
  source: 'bot',
  created_at: '2026-10-20T00:00:00Z',
  deleted: false,
  user_id: 'u1',
  ...extra,
})

describe('push', () => {
  it('clears dirty, stores rev, and never sends dirty/rev/user_id', async () => {
    const a = device()
    const row = await a.repo.put<Account>('accounts', acc)
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(res.pushed).toBe(1)
    const stored = await a.db.accounts.get(row.id as string)
    expect(stored).toMatchObject({ dirty: 0, rev: 1 })
    expect(Object.keys(remote.pushLog[0])).not.toContain('dirty')
    expect(Object.keys(remote.pushLog[0])).not.toContain('rev')
    expect(Object.keys(remote.pushLog[0])).not.toContain('user_id')
  })

  it('keeps dirty and reports error when push fails', async () => {
    const a = device()
    const row = await a.repo.put<Account>('accounts', acc)
    remote.failPush = true
    const res = await a.sync.syncOnce()
    expect(res.error).toMatch(/network down/)
    expect(res.pushed).toBe(0)
    expect((await a.db.accounts.get(row.id as string))!.dirty).toBe(1)
    remote.failPush = false
    const res2 = await a.sync.syncOnce()
    expect(res2.error).toBeUndefined()
    expect((await a.db.accounts.get(row.id as string))!.dirty).toBe(0)
  })

  it('keeps dirty when the row was edited while the push was in flight', async () => {
    const a = device()
    const row = await a.repo.put<Account>('accounts', acc)
    const origPush = remote.push.bind(remote)
    remote.push = async (table, rows) => {
      const out = await origPush(table, rows)
      await a.repo.put<Account>('accounts', { id: row.id, name: 'Правка' })
      return out
    }
    await a.sync.syncOnce()
    const stored = await a.db.accounts.get(row.id as string)
    expect(stored).toMatchObject({ name: 'Правка', dirty: 1 })
    expect(stored!.rev).toBe(1)
  })
})

describe('push isolation (I1)', () => {
  it('a rejected row does not block pulling, is parked with its message, and its chunk-mates still go out', async () => {
    const a = device()
    const r1 = await a.repo.put<Account>('accounts', { ...acc, name: 'Один' })
    const r2 = await a.repo.put<Account>('accounts', { ...acc, name: 'Плохой' })
    const r3 = await a.repo.put<Account>('accounts', { ...acc, name: 'Три' })
    remote.reject.set(r2.id, 'violates check constraint "accounts_name_check"')
    remote.seed('transactions', botTx('bot-1'))

    const res = await a.sync.syncOnce()

    expect(await a.db.transactions.get('bot-1')).toMatchObject({ note: 'bot', dirty: 0 })
    expect(remote.t('accounts').has(r1.id)).toBe(true)
    expect(remote.t('accounts').has(r3.id)).toBe(true)
    expect(remote.t('accounts').has(r2.id)).toBe(false)
    expect(await a.db.accounts.get(r1.id)).toMatchObject({ dirty: 0 })
    expect(await a.db.accounts.get(r3.id)).toMatchObject({ dirty: 0 })
    expect(await a.db.accounts.get(r2.id)).toMatchObject({ dirty: 2 })
    expect(await a.db.meta.get(`parked:accounts:${r2.id}`)).toMatchObject({
      value: { table: 'accounts', id: r2.id, error: 'violates check constraint "accounts_name_check"' },
    })
    expect(res.parked).toBe(1)
    expect(res.error).toMatch(/accounts_name_check/)
  })

  it('a parked row is not retried every sync, but is retried after the user edits it', async () => {
    const a = device()
    const bad = await a.repo.put<Account>('accounts', { ...acc, name: 'Плохой' })
    remote.reject.set(bad.id, 'bad row')
    await a.sync.syncOnce()
    const before = remote.attempted.length
    expect(before).toBeGreaterThan(0)
    const res2 = await a.sync.syncOnce()
    expect(res2.error).toBeUndefined()
    expect(remote.attempted.length).toBe(before)

    remote.reject.clear()
    await a.repo.put<Account>('accounts', { id: bad.id, name: 'Исправлен' })
    await a.sync.syncOnce()
    expect(remote.t('accounts').get(bad.id)).toMatchObject({ name: 'Исправлен' })
    expect(await a.db.accounts.get(bad.id)).toMatchObject({ dirty: 0 })
    expect(await a.db.meta.get(`parked:accounts:${bad.id}`)).toBeUndefined()
  })

  it('parked rows are retried on app start (a new sync instance)', async () => {
    const a = device()
    const bad = await a.repo.put<Account>('accounts', { ...acc, name: 'Плохой' })
    remote.reject.set(bad.id, 'bad row')
    await a.sync.syncOnce()
    expect((await a.db.accounts.get(bad.id))!.dirty).toBe(2)
    remote.reject.clear()
    const restarted = createSync(a.db, remote)
    const res = await restarted.syncOnce()
    expect(res.error).toBeUndefined()
    expect(await a.db.accounts.get(bad.id)).toMatchObject({ dirty: 0 })
    expect(await a.db.meta.get(`parked:accounts:${bad.id}`)).toBeUndefined()
  })

  it('a failing table does not stop the other tables or the pulls', async () => {
    const a = device()
    const account = await a.repo.put<Account>('accounts', acc)
    const goal = await a.repo.put<Goal>('goals', { name: 'Машина', target_usd: 100, deadline: null, archived: false })
    remote.seed('transactions', botTx('bot-1'))
    const origPush = remote.push.bind(remote)
    remote.push = async (table, rows) => {
      if (table === 'accounts') throw new Error('timeout on accounts')
      return origPush(table, rows)
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toMatch(/timeout on accounts/)
    expect(await a.db.accounts.get(account.id as string)).toMatchObject({ dirty: 1 }) // transient: stays dirty, not parked
    expect(await a.db.goals.get(goal.id as string)).toMatchObject({ dirty: 0 })
    expect(await a.db.transactions.get('bot-1')).toBeTruthy()
  })
})

describe('pull', () => {
  it('brings a row created by the bot on the server', async () => {
    const a = device()
    remote.seed('transactions', botTx('bot-1'))
    const res = await a.sync.syncOnce()
    expect(res.pulled).toBe(1)
    expect(await a.db.transactions.get('bot-1')).toMatchObject({ note: 'bot', dirty: 0, rev: 1, source: 'bot' })
  })

  it('does not overwrite a locally dirty row', async () => {
    const a = device()
    remote.seed('accounts', { id: 'acc-1', ...acc, name: 'С сервера', deleted: false })
    // the user edits the row while the pull request is in flight
    const origPull = remote.pull.bind(remote)
    remote.pull = async (table, since) => {
      const rows = await origPull(table, since)
      await a.repo.put<Account>('accounts', { ...acc, id: 'acc-1', name: 'Локально' })
      return rows
    }
    await a.sync.syncOnce()
    expect(await a.db.accounts.get('acc-1')).toMatchObject({ name: 'Локально', dirty: 1 })
  })

  it('a deletion reaches another copy', async () => {
    const a = device()
    const b = device()
    const row = await a.repo.put<Account>('accounts', acc)
    await a.sync.syncOnce()
    await b.sync.syncOnce()
    expect((await b.db.accounts.get(row.id as string))!.deleted).toBe(false)
    await a.repo.remove('accounts', row.id as string)
    await a.sync.syncOnce()
    await b.sync.syncOnce()
    expect(await b.db.accounts.get(row.id as string)).toMatchObject({ deleted: true, dirty: 0 })
  })

  it('applies a row whose rev is below last_rev but within the overlap', async () => {
    const a = device()
    remote.seed('transactions', botTx('t-120'), 120)
    await a.sync.syncOnce()
    expect((await a.db.meta.get('last_rev:transactions'))!.value).toBe(120)
    remote.seed('transactions', botTx('t-late'), 100) // committed late, rev below last_rev
    remote.seed('transactions', botTx('t-too-old'), 60) // outside the 50 window
    await a.sync.syncOnce()
    expect(await a.db.transactions.get('t-late')).toBeTruthy()
    expect(await a.db.transactions.get('t-too-old')).toBeUndefined()
    expect((await a.db.meta.get('last_rev:transactions'))!.value).toBe(120)
  })

  it('reports a pull error and leaves last_rev alone', async () => {
    const a = device()
    remote.seed('transactions', botTx('bot-1'))
    remote.failPull = true
    const res = await a.sync.syncOnce()
    expect(res.error).toMatch(/network down/)
    expect(await a.db.meta.get('last_rev:transactions')).toBeUndefined()
  })
})

describe('fx rates', () => {
  it('a rate_pending transaction gets the exact rate after sync and goes out on the next pass', async () => {
    const a = device()
    await a.db.fx_rates.bulkPut([
      { date: '2026-10-19', currency: 'UAH', uah_per_unit: 1 },
      { date: '2026-10-19', currency: 'USD', uah_per_unit: 40 },
    ])
    const tx = await a.repo.addTransaction({
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      account_id: 'a',
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-21',
      note: '',
      source: 'app',
    })
    expect(tx.rate_pending).toBe(true)
    remote.fx['2026-10-21'] = [
      { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 },
      { date: '2026-10-21', currency: 'USD', uah_per_unit: 41.25 },
    ]
    await a.sync.syncOnce()
    const after = (await a.db.transactions.get(tx.id)) as Transaction & { dirty: number }
    expect(after.rate_pending).toBe(false)
    expect(after.amount_usd).toBe(1.94)
    // the fix goes out as a column-scoped patch, not as a dirty whole row
    expect(after.dirty).toBe(0)
    expect(await a.db.fx_rates.get(['2026-10-21', 'USD'])).toBeTruthy()
    expect(remote.patchLog).toEqual([[{ id: tx.id, rate_usd: 1 / 41.25, amount_usd: 1.94 }]])
    expect(remote.t('transactions').get(tx.id)).toMatchObject({ amount_usd: 1.94, rate_pending: false })
    // the server result (new rev) was pulled back
    expect(after.rev).toBe(remote.t('transactions').get(tx.id)!.rev)
    expect(await a.db.meta.get('rate_fix')).toMatchObject({ value: [] })
  })

  it('I3: a rate fix does not resurrect a row the bot deleted or revert its category', async () => {
    const a = device()
    remote.seed('transactions', botTx('bot-p', { currency: 'UAH', amount: 80, rate_usd: 0, amount_usd: 0, rate_pending: true, category_id: 'old', date: '2026-10-21' }))
    remote.seed('transactions', botTx('bot-q', { currency: 'UAH', amount: 40, rate_usd: 0, amount_usd: 0, rate_pending: true, category_id: 'old', date: '2026-10-21' }))
    await a.sync.syncOnce() // pulled while still pending
    expect(await a.db.transactions.get('bot-p')).toMatchObject({ rate_pending: true, dirty: 0 })
    remote.fxRates = async (date) => {
      // meanwhile, on the server, the bot deletes one row and re-categorises the other
      remote.seed('transactions', { ...remote.t('transactions').get('bot-p')!, deleted: true })
      remote.seed('transactions', { ...remote.t('transactions').get('bot-q')!, category_id: 'new' })
      return [
        { date, currency: 'UAH', uah_per_unit: 1 },
        { date, currency: 'USD', uah_per_unit: 40 },
      ]
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(remote.t('transactions').get('bot-p')).toMatchObject({ deleted: true })
    expect(remote.t('transactions').get('bot-q')).toMatchObject({ category_id: 'new', amount_usd: 1, rate_pending: false })
    // nothing was pushed as a whole row
    expect(remote.pushLog).toHaveLength(0)
    // and the local copy follows the server
    expect(await a.db.transactions.get('bot-p')).toMatchObject({ deleted: true, dirty: 0 })
    expect(await a.db.transactions.get('bot-q')).toMatchObject({ category_id: 'new', amount_usd: 1, rate_pending: false, dirty: 0 })
  })

  it('I3: a failed rate patch is kept in the local marker and retried on the next sync', async () => {
    const a = device()
    remote.seed('transactions', botTx('bot-p', { currency: 'UAH', amount: 80, rate_usd: 0, amount_usd: 0, rate_pending: true, date: '2026-10-21' }))
    remote.fx['2026-10-21'] = [
      { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 },
      { date: '2026-10-21', currency: 'USD', uah_per_unit: 40 },
    ]
    const origPatch = remote.patchRates.bind(remote)
    remote.patchRates = async () => {
      throw new Error('network down')
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(res.fxError).toMatch(/network down/)
    expect(await a.db.transactions.get('bot-p')).toMatchObject({ amount_usd: 2, rate_pending: false, dirty: 0 })
    expect(await a.db.meta.get('rate_fix')).toMatchObject({ value: ['bot-p'] })
    remote.patchRates = origPatch
    await a.sync.syncOnce()
    expect(remote.t('transactions').get('bot-p')).toMatchObject({ amount_usd: 2, rate_pending: false })
    expect(await a.db.meta.get('rate_fix')).toMatchObject({ value: [] })
  })

  it('I2: asks fx-rates for every currency in settings, including added ones', async () => {
    const a = device()
    await a.repo.initDefaults('single', [])
    const s = (await a.db.settings.toCollection().first())!
    await a.db.settings.put({ ...s, currencies: [...s.currencies, 'GBP'] })
    await a.sync.syncOnce()
    expect(remote.fxCurrencies[0]).toEqual(expect.arrayContaining(['UAH', 'USD', 'EUR', 'MDL', 'GBP']))
  })

  it('I1: an fx-rates failure is reported apart and does not mark the sync as failed', async () => {
    const a = device()
    await a.repo.initDefaults('single', [])
    remote.fxRates = async () => {
      throw new Error('fx down')
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(res.fxError).toMatch(/fx down/)
    expect(res.pushed).toBeGreaterThan(0)
  })

  it('recomputes from the current row when it was edited during the rate fetch', async () => {
    const a = device()
    const tx = await a.repo.addTransaction({
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      account_id: 'a',
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-21',
      note: '',
      source: 'app',
    })
    expect(tx.rate_pending).toBe(true)
    const rates = [
      { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 },
      { date: '2026-10-21', currency: 'EUR', uah_per_unit: 50 },
      { date: '2026-10-21', currency: 'USD', uah_per_unit: 40 },
    ]
    remote.fxRates = async (date) => {
      // the user changes the transaction while the request is in flight
      await a.db.transactions.update(tx.id, { amount: 20, currency: 'EUR', dirty: 1 })
      return date === '2026-10-21' ? rates : []
    }
    await a.sync.syncOnce()
    const after = (await a.db.transactions.get(tx.id))!
    expect(after).toMatchObject({ amount: 20, currency: 'EUR', rate_usd: 1.25, amount_usd: 25, rate_pending: false, dirty: 1 })
  })

  it('leaves a transaction deleted during the rate fetch untouched', async () => {
    const a = device()
    const tx = await a.repo.addTransaction({
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      account_id: 'a',
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-21',
      note: '',
      source: 'app',
    })
    remote.fxRates = async () => {
      await a.repo.remove('transactions', tx.id)
      return [
        { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 },
        { date: '2026-10-21', currency: 'USD', uah_per_unit: 40 },
      ]
    }
    await a.sync.syncOnce()
    expect(await a.db.transactions.get(tx.id)).toMatchObject({ deleted: true, rate_pending: true, amount_usd: 0 })
  })

  it('fetches and stores today rates when settings currencies lack an exact rate (R15)', async () => {
    const a = device()
    await a.repo.initDefaults('single', [])
    // device clock is real in syncOnce; make the remote answer whatever date is asked
    const asked: string[] = []
    remote.fxRates = async (date) => {
      asked.push(date)
      return [
        { date, currency: 'UAH', uah_per_unit: 1 },
        { date, currency: 'USD', uah_per_unit: 41 },
        { date, currency: 'EUR', uah_per_unit: 48 },
        { date, currency: 'MDL', uah_per_unit: 2.3 },
      ]
    }
    await a.sync.syncOnce()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await a.db.fx_rates.count()).toBe(4)
    await a.sync.syncOnce() // exact rates now exist for today -> no further request
    expect(asked).toHaveLength(1)
  })

  it('does not request rates when there are no settings and no pending transactions', async () => {
    const a = device()
    await a.sync.syncOnce()
    expect(remote.fxCalls).toEqual([])
  })
})

describe('concurrency', () => {
  it('overlapping syncOnce calls share one run', async () => {
    const a = device()
    await a.repo.put<Account>('accounts', acc)
    const [r1, r2] = await Promise.all([a.sync.syncOnce(), a.sync.syncOnce()])
    expect(r1).toBe(r2)
    expect(remote.pushLog).toHaveLength(1)
  })
})

describe('field reality (stage 0)', () => {
  const tx = {
    kind: 'expense' as const,
    amount: 10,
    currency: 'USD',
    account_id: 'a',
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: null,
    date: '2026-10-21',
    note: 'first',
    source: 'app' as const,
  }

  it('offline push keeps rows dirty and reports error, next sync sends them', async () => {
    const a = device()
    const row = await a.repo.put<Account>('accounts', acc)
    const origPush = remote.push.bind(remote)
    remote.push = async () => {
      throw new TypeError('Failed to fetch')
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toContain('Failed to fetch')
    expect(res.pushed).toBe(0)
    expect((await a.db.accounts.get(row.id as string))!.dirty).toBe(1)
    expect(remote.t('accounts').size).toBe(0)

    remote.push = origPush
    const res2 = await a.sync.syncOnce()
    expect(res2.error).toBeUndefined()
    expect((await a.db.accounts.get(row.id as string))!.dirty).toBe(0)
    expect(remote.t('accounts').size).toBe(1)
    expect(remote.t('accounts').has(row.id as string)).toBe(true)
  })

  it('a row saved twice while offline goes out once with the latest content', async () => {
    const a = device()
    const row = await a.repo.addTransaction(tx)
    await a.sync.syncOnce()
    remote.pushLog.length = 0

    remote.failPush = true
    await a.repo.updateTransaction(row.id, { note: 'second' })
    await a.repo.updateTransaction(row.id, { note: 'third' })
    const offline = await a.sync.syncOnce()
    expect(offline.error).toMatch(/network down/)
    expect(remote.pushLog).toHaveLength(0)

    remote.failPush = false
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(remote.pushLog).toHaveLength(1)
    expect(remote.pushLog[0]).toMatchObject({ id: row.id, note: 'third' })
    expect(remote.t('transactions').size).toBe(1)
    expect(remote.t('transactions').get(row.id)).toMatchObject({ note: 'third' })
    expect((await a.db.transactions.get(row.id))!.dirty).toBe(0)
  })

  it('two devices edit the same row: the later push wins on both after pull', async () => {
    const phone = device()
    const pc = device()
    const row = await phone.repo.addTransaction(tx)
    await phone.sync.syncOnce()
    await pc.sync.syncOnce()
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ note: 'first', dirty: 0 })

    // both edit the same row before either syncs
    await phone.repo.updateTransaction(row.id, { note: 'from phone' })
    await pc.repo.updateTransaction(row.id, { note: 'from pc' })

    await phone.sync.syncOnce()
    await pc.sync.syncOnce() // pc pushes last: its edit is the server's final version
    await phone.sync.syncOnce()

    expect(remote.t('transactions').get(row.id)).toMatchObject({ note: 'from pc' })
    expect(await phone.db.transactions.get(row.id)).toMatchObject({ note: 'from pc', dirty: 0 })
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ note: 'from pc', dirty: 0 })
  })
})
