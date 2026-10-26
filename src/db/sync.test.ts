import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSoftTable, type Account, type FxRate, type Goal, type Settings, type SyncTable, type Transaction } from '@shared/types.ts'
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
    // like Postgres: NOT NULL is checked on the proposed INSERT row, so a partial upsert fails
    if (table === 'settings' && rows.some((r) => !('base_currency' in r))) {
      throw new RowRejectedError('null value in column "base_currency" violates not-null constraint')
    }
    return this.store(table, rows)
  }
  /** like update(fields).eq('id', id): only the sent columns, only an existing row */
  async pushColumns(table: SyncTable, row: object) {
    if (this.failPush) throw new Error('network down')
    const id = (row as { id: string }).id
    this.attempted.push(id)
    if (this.reject.has(id)) throw new RowRejectedError(this.reject.get(id)!)
    if (!this.t(table).has(id)) return []
    return this.store(table, [row])
  }
  private store(table: SyncTable, rows: object[]) {
    return rows.map((r) => {
      this.pushLog.push(r)
      // deleted_rev is server-owned: a pushed value is ignored, like the trigger does
      const { base_rev, deleted_rev: _ignored, ...incoming } = r as Record<string, unknown> & {
        id: string
        base_rev?: number | null
      }
      const prev = this.t(table).get(incoming.id)
      const rev = this.nextRev++
      // an upsert updates only the columns it sends (a column-scoped settings push keeps the rest)
      const stored: Record<string, unknown> = { ...prev, ...incoming, rev }
      // like the v1.1 set_rev() trigger: `deleted` is final; a soft deletion stays unless base_rev >= deleted_rev;
      // the server-owned settings columns keep their values (a client is never the service role)
      if (prev) {
        if (prev.deleted === true) stored.deleted = true
        const lifts = prev.deleted_at != null && incoming.deleted_at === null
        const deletedRev = (prev.deleted_rev ?? prev.rev) as number
        if (lifts && (base_rev == null || base_rev < deletedRev)) {
          stored.deleted_at = prev.deleted_at
          stored.deleted_batch = prev.deleted_batch
        }
        if (table === 'settings') {
          for (const k of ['keepalive_at', 'last_reminder_at', 'partner_seen_at']) stored[k] = prev[k] ?? null
        }
      }
      if (isSoftTable(table)) {
        const binned = (stored.deleted_at ?? null) !== null
        const wasBinned = (prev?.deleted_at ?? null) !== null
        stored.deleted_rev = !binned ? null : wasBinned ? (prev!.deleted_rev ?? prev!.rev) : rev
      }
      this.t(table).set(incoming.id, stored)
      const soft = 'deleted_at' in stored ? { deleted_at: stored.deleted_at as string | null, deleted_batch: stored.deleted_batch as string | null } : {}
      return { id: incoming.id, rev, deleted: stored.deleted as boolean, ...soft }
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
  // like update(...).eq('id', id).eq('rate_pending', true).is('deleted_at', null): only the rate columns,
  // only while still pending and not in the bin
  async patchRates(rows: RatePatch[]) {
    this.patchLog.push(rows)
    for (const p of rows) {
      const row = this.t('transactions').get(p.id)
      if (!row || row.rate_pending !== true || (row.deleted_at ?? null) !== null) continue
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
  // the device number is fixed now: `n` moves on with the next device(), ids must not follow it
  const me = ++n
  const db = createDb(`sync-test-${me}`)
  dbs.push(db)
  let u = 0
  const repo = createRepo(db, {
    now: () => new Date('2026-10-21T10:00:00Z'),
    uuid: () => `d${me}-${++u}`,
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

  it('toWire sends base_rev: null for a new row, the last seen rev for an edit', async () => {
    const a = device()
    const row = await a.repo.put<Account>('accounts', acc)
    await a.sync.syncOnce()
    expect(remote.pushLog[0]).toMatchObject({ id: row.id, base_rev: null })
    await a.repo.put<Account>('accounts', { id: row.id, name: 'Новая' })
    await a.sync.syncOnce()
    expect(remote.pushLog[1]).toMatchObject({ id: row.id, name: 'Новая', base_rev: 1 })
    expect(Object.keys(remote.pushLog[1])).not.toContain('rev')
    expect(await a.db.accounts.get(row.id)).toMatchObject({ rev: 2, dirty: 0 })
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

  it('batched resolvePendingRates: one fxRatesBatch call for every pending date (chunks of 60), no per-date calls', async () => {
    const a = device()
    // 65 pending rows on 65 different dates (a big CSV import)
    const dates = Array.from({ length: 65 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10))
    dates.forEach((date, i) => remote.seed('transactions', botTx(`imp-${i}`, { currency: 'UAH', amount: 40, rate_usd: 0, amount_usd: 0, rate_pending: true, date })))
    const batches: { dates: string[]; currencies: string[] }[] = []
    const batched = remote as typeof remote & { fxRatesBatch: (d: string[], c: string[]) => Promise<FxRate[]> }
    batched.fxRatesBatch = async (ds, cs) => {
      batches.push({ dates: ds, currencies: cs })
      return ds.flatMap((date) => [{ date, currency: 'UAH', uah_per_unit: 1 }, { date, currency: 'USD', uah_per_unit: 40 }])
    }
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    expect(batches.map((b) => b.dates.length)).toEqual([60, 5])
    expect(new Set(batches.flatMap((b) => b.dates))).toEqual(new Set(dates))
    expect(batches[0].currencies).toContain('UAH')
    expect(remote.fxCalls.filter((d) => d !== '2026-10-22' && dates.includes(d))).toEqual([])
    expect(await a.db.transactions.get('imp-64')).toMatchObject({ amount_usd: 1, rate_pending: false })
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
    // remove() is soft now: the row sits in the undo bin, and a row in the bin is not rate-fixed either
    expect(await a.db.transactions.get(tx.id)).toMatchObject({
      deleted: false,
      deleted_at: '2026-10-21T10:00:00.000Z',
      rate_pending: true,
      amount_usd: 0,
    })
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

describe('deletion wins (1.1)', () => {
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

  /** phone and pc share one synced record; the phone then deletes it and syncs. */
  async function deletedOnPhone() {
    const phone = device()
    const pc = device()
    const row = await phone.repo.addTransaction(tx)
    await phone.sync.syncOnce()
    await pc.sync.syncOnce()
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ deleted_at: null, dirty: 0 })
    const batch = (await phone.repo.remove('transactions', row.id))!
    await phone.sync.syncOnce()
    expect(remote.t('transactions').get(row.id)).toMatchObject({ deleted_at: '2026-10-21T10:00:00.000Z', deleted_batch: batch })
    return { phone, pc, row, batch }
  }

  it('remote deletion beats a local dirty edit: the pull brings it, the edit is not sent again (Review Focus 1)', async () => {
    const { pc, row, batch } = await deletedOnPhone()
    // pc, offline, edits the same record
    await pc.repo.updateTransaction(row.id, { note: 'from pc' })
    remote.failPush = true // the push cannot get out, the pull can
    await pc.sync.syncOnce()
    expect(await pc.db.transactions.get(row.id)).toMatchObject({
      deleted_at: '2026-10-21T10:00:00.000Z',
      deleted_batch: batch,
      note: 'first',
      dirty: 0,
    })

    remote.failPush = false
    const sent = remote.pushLog.length
    await pc.sync.syncOnce()
    expect(remote.pushLog).toHaveLength(sent)
    expect(remote.t('transactions').get(row.id)).toMatchObject({ note: 'first', deleted_at: '2026-10-21T10:00:00.000Z' })
  })

  it('push echo: when the server keeps a deletion, the pushing device shows it again', async () => {
    const { pc, row, batch } = await deletedOnPhone()
    await pc.repo.updateTransaction(row.id, { note: 'from pc' })
    await pc.sync.syncOnce() // push first: base_rev is older than the deletion, the server keeps it
    expect(remote.t('transactions').get(row.id)).toMatchObject({ note: 'from pc', deleted_at: '2026-10-21T10:00:00.000Z' })
    expect(await pc.db.transactions.get(row.id)).toMatchObject({
      note: 'from pc',
      deleted_at: '2026-10-21T10:00:00.000Z',
      deleted_batch: batch,
      dirty: 0,
    })
    const sent = remote.pushLog.length
    await pc.sync.syncOnce()
    expect(remote.pushLog).toHaveLength(sent)
  })

  it('a restore made after seeing the deletion goes through (base_rev = current rev) and reaches the other device', async () => {
    const { phone, pc, row, batch } = await deletedOnPhone()
    await pc.sync.syncOnce()
    expect(await pc.repo.restore(batch)).toBe(1)
    await pc.sync.syncOnce()
    expect(remote.t('transactions').get(row.id)).toMatchObject({ deleted_at: null, deleted_batch: null })
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ deleted_at: null, dirty: 0 })
    await phone.sync.syncOnce()
    expect(await phone.db.transactions.get(row.id)).toMatchObject({ deleted_at: null, dirty: 0 })
  })

  it('a local restore is not undone by re-pulling the deletion it has already seen (overlap)', async () => {
    const { pc, row, batch } = await deletedOnPhone()
    await pc.sync.syncOnce()
    await pc.repo.restore(batch)
    remote.failPush = true
    await pc.sync.syncOnce()
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ deleted_at: null, dirty: 1 })
    remote.failPush = false
    await pc.sync.syncOnce()
    expect(remote.t('transactions').get(row.id)).toMatchObject({ deleted_at: null })
  })

  it('a final deletion on the server also wins over a local dirty edit', async () => {
    const pc = device()
    remote.seed('transactions', botTx('bot-1'))
    await pc.sync.syncOnce()
    await pc.repo.updateTransaction('bot-1', { note: 'from pc' })
    remote.seed('transactions', { ...remote.t('transactions').get('bot-1')!, deleted: true })
    remote.failPush = true
    await pc.sync.syncOnce()
    expect(await pc.db.transactions.get('bot-1')).toMatchObject({ deleted: true, note: 'bot', dirty: 0 })
  })

  // I2 (final review): the restore is judged by the deletion's rev, not by the row's latest rev
  it('a restore still goes through after an unrelated server write to the binned row', async () => {
    const { pc, row, batch } = await deletedOnPhone()
    await pc.sync.syncOnce() // pc sees the deletion
    const deletionRev = (await pc.db.transactions.get(row.id))!.rev!
    expect(remote.t('transactions').get(row.id)!.deleted_rev).toBe(deletionRev)
    // the bot (or another device) writes to the row while it sits in the bin; pc has not pulled that yet
    remote.seed('transactions', { ...remote.t('transactions').get(row.id)!, note: 'bot' })
    expect(await pc.repo.restore(batch)).toBe(1)
    await pc.sync.syncOnce()
    expect(remote.t('transactions').get(row.id)).toMatchObject({ deleted_at: null, deleted_batch: null, deleted_rev: null })
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ deleted_at: null, dirty: 0 })
    // deleted_rev is server-owned: it is never sent
    expect(remote.pushLog.every((r) => !('deleted_rev' in r))).toBe(true)
  })

  it('a device that never saw the deletion still cannot resurrect it after later server writes', async () => {
    const { pc, row, batch } = await deletedOnPhone()
    remote.seed('transactions', { ...remote.t('transactions').get(row.id)!, note: 'bot' })
    // pc never pulled the deletion: its copy is alive and its edit carries the old rev
    await pc.repo.updateTransaction(row.id, { note: 'from pc' })
    remote.failPull = true
    await pc.sync.syncOnce()
    remote.failPull = false
    expect(remote.t('transactions').get(row.id)).toMatchObject({ deleted_at: '2026-10-21T10:00:00.000Z', deleted_batch: batch })
    expect(await pc.db.transactions.get(row.id)).toMatchObject({ deleted_batch: batch, dirty: 0 })
  })

  it('a rate fix leaves a row that went to the bin on the server alone', async () => {
    remote.seed('transactions', botTx('bot-1', { rate_pending: true, deleted_at: '2026-10-21T09:00:00.000Z', deleted_batch: 'b', deleted_rev: 1 }))
    const before = remote.t('transactions').get('bot-1')!.rev
    await remote.patchRates([{ id: 'bot-1', rate_usd: 1, amount_usd: 100 }])
    expect(remote.t('transactions').get('bot-1')!.rev).toBe(before)
  })
})

// I1 (final review): settings go out column by column, so a device offline for weeks cannot undo what the
// bot or another device changed in other fields meanwhile.
describe('settings push (column-scoped)', () => {
  async function syncedSettings() {
    const a = device()
    await a.repo.initDefaults('single', [])
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()
    const s = (await a.db.settings.toArray())[0]
    // a row that was never pushed goes out whole
    const first = remote.pushLog.find((r) => (r as { id: string }).id === s.id) as Record<string, unknown>
    expect(first).toMatchObject({ base_rev: null, default_currency: 'UAH', reserve_usd: 0, timezone: 'Europe/Kyiv' })
    expect(s).toMatchObject({ dirty: 0 })
    expect(s).not.toHaveProperty('_changed')
    return { a, id: s.id }
  }

  it('offline device changes reserve_usd while the server changed default_currency: after sync both survive', async () => {
    const { a, id } = await syncedSettings()
    // the bot changes the default currency on the server
    remote.seed('settings', { ...remote.t('settings').get(id)!, default_currency: 'EUR', keepalive_at: '2026-10-20T08:00:00Z' })
    // the device, offline, changes the reserve
    await a.repo.put<Settings>('settings', { id, reserve_usd: 500 })
    expect(await a.db.settings.get(id)).toMatchObject({ _changed: ['reserve_usd'], dirty: 1 })
    remote.failPush = true
    await a.sync.syncOnce()
    remote.failPush = false
    remote.pushLog.length = 0
    const res = await a.sync.syncOnce()
    expect(res.error).toBeUndefined()

    // only the changed field went out
    expect(remote.pushLog).toEqual([{ id, base_rev: expect.any(Number), reserve_usd: 500 }])
    expect(remote.t('settings').get(id)).toMatchObject({ reserve_usd: 500, default_currency: 'EUR', keepalive_at: '2026-10-20T08:00:00Z' })
    // and the device ends up with the merged row
    const local = await a.db.settings.get(id)
    expect(local).toMatchObject({ reserve_usd: 500, default_currency: 'EUR', keepalive_at: '2026-10-20T08:00:00Z', dirty: 0 })
    expect(local).not.toHaveProperty('_changed')
    expect(local!.rev).toBe(remote.t('settings').get(id)!.rev)
  })

  it('changed fields add up over several edits; a whole-row put records only the fields that differ', async () => {
    const { a, id } = await syncedSettings()
    await a.repo.put<Settings>('settings', { id, reserve_usd: 100 })
    const current = (await a.db.settings.get(id))!
    // Home.tsx style: the whole row with one field changed
    await a.repo.put<Settings>('settings', { ...current, next_contract_date: '2026-12-01' })
    await a.repo.put<Settings>('settings', { id, reserve_usd: 200 })
    expect((await a.db.settings.get(id))!._changed).toEqual(['reserve_usd', 'next_contract_date'])
    remote.pushLog.length = 0
    await a.sync.syncOnce()
    expect(remote.pushLog).toEqual([{ id, base_rev: expect.any(Number), reserve_usd: 200, next_contract_date: '2026-12-01' }])
  })

  it('goes out whole when the server has no such row, or when the edit predates field tracking', async () => {
    const { a, id } = await syncedSettings()
    remote.t('settings').delete(id) // removed on the server (cleanup)
    await a.repo.put<Settings>('settings', { id, reserve_usd: 100 })
    remote.pushLog.length = 0
    expect((await a.sync.syncOnce()).error).toBeUndefined()
    expect(remote.t('settings').get(id)).toMatchObject({ reserve_usd: 100, default_currency: 'UAH', timezone: 'Europe/Kyiv' })

    // a row left dirty by 1.0 (no _changed): its edit is not known field by field
    await a.db.settings.update(id, { reserve_usd: 300, dirty: 1 })
    remote.pushLog.length = 0
    await a.repo.put<Settings>('settings', { id, default_currency: 'EUR' })
    expect(await a.db.settings.get(id)).not.toHaveProperty('_changed')
    await a.sync.syncOnce()
    expect(remote.pushLog[0]).toMatchObject({ id, reserve_usd: 300, default_currency: 'EUR', timezone: 'Europe/Kyiv' })
  })

  it('removing the settings row records `deleted` as a changed field', async () => {
    const { a, id } = await syncedSettings()
    await a.repo.remove('settings', id)
    expect(await a.db.settings.get(id)).toMatchObject({ deleted: true, _changed: ['deleted'] })
  })

  it('an edit made while the push is in flight keeps the row dirty with its changed fields', async () => {
    const { a, id } = await syncedSettings()
    await a.repo.put<Settings>('settings', { id, reserve_usd: 100 })
    const origPush = remote.pushColumns.bind(remote)
    remote.pushColumns = async (table, row) => {
      const out = await origPush(table, row)
      await a.repo.put<Settings>('settings', { id, default_currency: 'USD' })
      return out
    }
    await a.sync.syncOnce()
    remote.pushColumns = origPush
    expect(await a.db.settings.get(id)).toMatchObject({ dirty: 1, default_currency: 'USD', _changed: ['reserve_usd', 'default_currency'] })
    remote.pushLog.length = 0
    await a.sync.syncOnce()
    expect(remote.pushLog).toEqual([{ id, base_rev: expect.any(Number), reserve_usd: 100, default_currency: 'USD' }])
    expect(remote.t('settings').get(id)).toMatchObject({ reserve_usd: 100, default_currency: 'USD' })
    expect(await a.db.settings.get(id)).not.toHaveProperty('_changed')
  })
})
