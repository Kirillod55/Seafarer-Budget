import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, FxRate, SyncTable, Transaction } from '@shared/types.ts'
import { createDb, type LocalDb } from './local.ts'
import { createRepo, type Repo } from './repo.ts'
import { createSync, type Remote } from './sync.ts'

class FakeRemote implements Remote {
  tables = new Map<SyncTable, Map<string, Record<string, unknown>>>()
  nextRev = 1
  failPush = false
  failPull = false
  fx: Record<string, FxRate[]> = {}
  fxCalls: string[] = []
  pushLog: object[] = []

  private t(table: SyncTable) {
    if (!this.tables.has(table)) this.tables.set(table, new Map())
    return this.tables.get(table)!
  }
  async push(table: SyncTable, rows: object[]) {
    if (this.failPush) throw new Error('network down')
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
  async fxRates(date: string) {
    this.fxCalls.push(date)
    return this.fx[date] ?? []
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
    expect(after.dirty).toBe(1)
    expect(await a.db.fx_rates.get(['2026-10-21', 'USD'])).toBeTruthy()
    await a.sync.syncOnce()
    expect((await a.db.transactions.get(tx.id))!.dirty).toBe(0)
    expect((remote.tables.get('transactions')!.get(tx.id) as { amount_usd: number }).amount_usd).toBe(1.94)
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
