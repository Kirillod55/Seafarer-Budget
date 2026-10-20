import { localDate } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import { SYNC_TABLES, type FxRate, type Settings, type SyncTable } from '@shared/types.ts'
import type { LocalDb } from './local.ts'

export interface Remote {
  push(table: SyncTable, rows: object[]): Promise<{ id: string; rev: number }[]>
  pull(table: SyncTable, sinceRev: number): Promise<object[]>
  fxRates(date: string): Promise<FxRate[]>
}

export interface SyncResult {
  pushed: number
  pulled: number
  error?: string
}

const DEFAULT_OVERLAP = 50

type AnyRow = Record<string, unknown> & { id: string; rev?: number; dirty?: 0 | 1 }

// What the server gets: no local-only `dirty`, no server-owned `rev` / `user_id`.
function toWire(row: AnyRow): object {
  const { dirty: _dirty, rev: _rev, user_id: _user, ...rest } = row
  return rest
}

function sameContent(a: AnyRow, b: AnyRow): boolean {
  return JSON.stringify(toWire(a)) === JSON.stringify(toWire(b))
}

export function createSync(
  db: LocalDb,
  remote: Remote,
  opts: { overlap?: number } = {},
): { syncOnce(): Promise<SyncResult> } {
  const overlap = opts.overlap ?? DEFAULT_OVERLAP

  async function pushTable(table: SyncTable): Promise<number> {
    const t = db.syncTable(table)
    const dirty = (await t.where('dirty').equals(1).toArray()) as AnyRow[]
    if (dirty.length === 0) return 0
    const results = await remote.push(table, dirty.map(toWire))
    const snapshot = new Map(dirty.map((r) => [r.id, r]))
    await db.transaction('rw', t, async () => {
      for (const { id, rev } of results) {
        const current = (await t.get(id)) as AnyRow | undefined
        const sent = snapshot.get(id)
        if (!current || !sent) continue
        // If the row was edited while the push was in flight, keep it dirty so the edit goes out next time.
        const unchanged = sameContent(current, sent)
        await t.put({ ...current, rev, dirty: unchanged ? 0 : 1 } as never)
      }
    })
    return results.length
  }

  async function pullTable(table: SyncTable): Promise<number> {
    const t = db.syncTable(table)
    const metaKey = `last_rev:${table}`
    const last = ((await db.meta.get(metaKey))?.value as number | undefined) ?? 0
    const rows = (await remote.pull(table, Math.max(0, last - overlap))) as AnyRow[]
    if (rows.length === 0) return 0
    let applied = 0
    let maxRev = last
    await db.transaction('rw', t, db.meta, async () => {
      for (const row of rows) {
        const rev = Number(row.rev ?? 0)
        if (rev > maxRev) maxRev = rev
        const local = (await t.get(row.id)) as AnyRow | undefined
        if (local?.dirty === 1) continue // local edit wins until it is pushed
        if (local && local.rev === rev) continue // already have this version (our own push echoed back)
        await t.put({ ...row, rev, dirty: 0 } as never)
        applied++
      }
      await db.meta.put({ key: metaKey, value: maxRev })
    })
    return applied
  }

  // Make sure there is an exact rate set for today for every currency in settings.
  async function ensureTodayRates(): Promise<void> {
    const settings = (await db.settings.toCollection().filter((s) => !s.deleted).first()) as Settings | undefined
    if (!settings) return
    const today = localDate(new Date(), settings.timezone ?? 'Europe/Kyiv')
    const rates = await db.fx_rates.toArray()
    const missing = settings.currencies.some(
      (c) => c !== 'USD' && usdRate(rates, c, today)?.exact !== true,
    )
    if (!missing) return
    const fetched = await remote.fxRates(today)
    if (fetched.length) await db.fx_rates.bulkPut(fetched)
  }

  // Transactions saved without an exact rate: fetch rates for their dates, recompute, mark dirty.
  async function resolvePendingRates(): Promise<void> {
    const pending = await db.transactions.filter((t) => t.rate_pending && !t.deleted).toArray()
    if (pending.length === 0) return
    const dates = [...new Set(pending.map((t) => t.date))].sort()
    for (const date of dates) {
      const fetched = await remote.fxRates(date)
      if (fetched.length) await db.fx_rates.bulkPut(fetched)
    }
    for (const { id } of pending) {
      // The fetches above took time: re-read the row and recompute from its CURRENT values.
      await db.transaction('rw', db.transactions, db.fx_rates, async () => {
        const current = await db.transactions.get(id)
        if (!current || current.deleted || !current.rate_pending) return
        const found = usdRate(await db.fx_rates.toArray(), current.currency, current.date)
        if (!found) return
        const amount_usd = round2(current.amount * found.rate)
        const rate_pending = !found.exact
        if (found.rate === current.rate_usd && amount_usd === current.amount_usd && rate_pending === current.rate_pending) return
        await db.transactions.put({ ...current, rate_usd: found.rate, amount_usd, rate_pending, dirty: 1 })
      })
    }
  }

  let running: Promise<SyncResult> | null = null

  async function run(): Promise<SyncResult> {
    let pushed = 0
    let pulled = 0
    try {
      for (const table of SYNC_TABLES) pushed += await pushTable(table)
      for (const table of SYNC_TABLES) pulled += await pullTable(table)
      await ensureTodayRates()
      await resolvePendingRates()
      return { pushed, pulled }
    } catch (e) {
      return { pushed, pulled, error: e instanceof Error ? e.message : String(e) }
    }
  }

  function syncOnce(): Promise<SyncResult> {
    running ??= run().finally(() => {
      running = null
    })
    return running
  }

  return { syncOnce }
}
