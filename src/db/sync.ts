import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import { SYNC_TABLES, type FxRate, type Settings, type SyncTable } from '@shared/types.ts'
import type { LocalDb } from './local.ts'

/** The server answered and refused the rows (bad data, constraint) — retrying the same rows will not help. */
export class RowRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RowRejectedError'
  }
}

/** Column-scoped rate fix for a transaction that was saved without an exact rate. */
export interface RatePatch {
  id: string
  rate_usd: number
  amount_usd: number
}

/**
 * What the server stored for a pushed row. The deletion fields come back because the server may keep a
 * deletion over the pushed edit (deletion wins), and the pushing device never pulls its own row back.
 * `deleted_at` / `deleted_batch` only for tables that have them (SOFT_TABLES).
 */
export interface PushResult {
  id: string
  rev: number
  deleted?: boolean
  deleted_at?: string | null
  deleted_batch?: string | null
}

export interface Remote {
  /** Upsert rows; throws RowRejectedError when the server refuses them, any other error when it is unreachable. */
  push(table: SyncTable, rows: object[]): Promise<PushResult[]>
  pull(table: SyncTable, sinceRev: number): Promise<object[]>
  fxRates(date: string, currencies: string[]): Promise<FxRate[]>
  /** Sets rate_usd / amount_usd / rate_pending=false only on rows that are still rate_pending on the server. */
  patchRates(rows: RatePatch[]): Promise<void>
}

export interface SyncResult {
  pushed: number
  pulled: number
  /** rows the server refused in this run; they wait (dirty: 2) until edited or the app restarts */
  parked?: number
  /** push / pull failures */
  error?: string
  /** fx-rates or rate-fix failures: retried next time, not a sync failure */
  fxError?: string
}

export interface ParkedRow {
  table: SyncTable
  id: string
  error: string
}

const DEFAULT_OVERLAP = 50
const PUSH_CHUNK = 500
const RATE_FIX_KEY = 'rate_fix'
export const PARKED_PREFIX = 'parked:'
const parkedKey = (table: SyncTable, id: string) => `${PARKED_PREFIX}${table}:${id}`

// dirty: 0 = in sync, 1 = waiting to be pushed, 2 = parked (the server refused it)
type AnyRow = Record<string, unknown> & { id: string; rev?: number; dirty?: 0 | 1 | 2 }

// The row's own content: no local-only `dirty`, no server-owned `rev` / `user_id`, no per-request `base_rev`.
function content(row: AnyRow): object {
  const { dirty: _dirty, rev: _rev, user_id: _user, base_rev: _base, ...rest } = row
  return rest
}

// What the server gets: the content plus `base_rev` = the rev this edit was made on (null for a new row).
// The server keeps a soft deletion unless base_rev = its current rev, so a restore needs it on every push.
function toWire(row: AnyRow): object {
  return { ...content(row), base_rev: row.rev ?? null }
}

function sameContent(a: AnyRow, b: AnyRow): boolean {
  return JSON.stringify(content(a)) === JSON.stringify(content(b))
}

const DELETION_FIELDS = ['deleted', 'deleted_at', 'deleted_batch'] as const

// Postgres answers `2026-10-21T10:00:00+00:00` for the `…T10:00:00.000Z` the app sent: same instant, same value.
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string' && a !== b) {
    const [x, y] = [Date.parse(a), Date.parse(b)]
    return !Number.isNaN(x) && x === y
  }
  return a === b
}

/** A server row that is deleted for good or sits in the undo bin. */
const isDeletion = (row: AnyRow) => row.deleted === true || (row.deleted_at ?? null) !== null

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createSync(
  db: LocalDb,
  remote: Remote,
  opts: { overlap?: number } = {},
): { syncOnce(): Promise<SyncResult> } {
  const overlap = opts.overlap ?? DEFAULT_OVERLAP
  let started = false

  /** On app start every parked row gets another chance. */
  async function unparkAll(): Promise<void> {
    await db.transaction('rw', [...SYNC_TABLES.map((t) => db.syncTable(t)), db.meta], async () => {
      for (const table of SYNC_TABLES) {
        await db.syncTable(table).where('dirty').equals(2).modify({ dirty: 1 })
      }
      await db.meta.where('key').startsWith(PARKED_PREFIX).delete()
    })
  }

  /**
   * Record what the server stored; a row edited while the push was in flight stays dirty. Where the server
   * stored other deletion fields than were sent (it kept a deletion), they are taken over: deletion wins.
   */
  async function applyPushed(table: SyncTable, sent: AnyRow[], results: PushResult[]): Promise<void> {
    const t = db.syncTable(table)
    const snapshot = new Map(sent.map((r) => [r.id, r]))
    await db.transaction('rw', t, db.meta, async () => {
      for (const result of results) {
        const current = (await t.get(result.id)) as AnyRow | undefined
        const row = snapshot.get(result.id)
        if (!current || !row) continue
        const unchanged = sameContent(current, row)
        const server: Record<string, unknown> = {}
        for (const k of DELETION_FIELDS) {
          if (result[k] !== undefined && !sameValue(result[k], row[k] ?? null)) server[k] = result[k]
        }
        await t.put({ ...current, ...server, rev: result.rev, dirty: unchanged ? 0 : 1 } as never)
        await db.meta.delete(parkedKey(table, result.id))
      }
    })
  }

  async function park(table: SyncTable, row: AnyRow, error: string): Promise<void> {
    const t = db.syncTable(table)
    await db.transaction('rw', t, db.meta, async () => {
      const current = (await t.get(row.id)) as AnyRow | undefined
      // edited meanwhile: the new version deserves its own try
      if (!current || current.dirty !== 1 || !sameContent(current, row)) return
      await t.put({ ...current, dirty: 2 } as never)
      const value: ParkedRow = { table, id: row.id, error }
      await db.meta.put({ key: parkedKey(table, row.id), value })
    })
  }

  async function pushTable(table: SyncTable): Promise<{ pushed: number; parked: string[] }> {
    const t = db.syncTable(table)
    const dirty = (await t.where('dirty').equals(1).toArray()) as AnyRow[]
    let pushed = 0
    const parked: string[] = []
    for (let i = 0; i < dirty.length; i += PUSH_CHUNK) {
      const chunk = dirty.slice(i, i + PUSH_CHUNK)
      try {
        const results = await remote.push(table, chunk.map(toWire))
        await applyPushed(table, chunk, results)
        pushed += results.length
        continue
      } catch (e) {
        if (!(e instanceof RowRejectedError)) throw e // unreachable server: keep everything dirty
      }
      // the server refused the chunk: find the culprits one by one
      for (const row of chunk) {
        try {
          const results = await remote.push(table, [toWire(row)])
          await applyPushed(table, [row], results)
          pushed += results.length
        } catch (e) {
          if (!(e instanceof RowRejectedError)) throw e
          await park(table, row, e.message)
          parked.push(e.message)
        }
      }
    }
    return { pushed, parked }
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
        if (local && local.rev === rev) continue // already have this version (our own push echoed back)
        const pending = local?.dirty === 1 || local?.dirty === 2
        // a local edit wins until it is pushed, except over a deletion made elsewhere: that edit is dropped
        if (pending && !isDeletion(row)) continue
        await t.put({ ...row, rev, dirty: 0 } as never)
        if (pending) await db.meta.delete(parkedKey(table, row.id))
        applied++
      }
      await db.meta.put({ key: metaKey, value: maxRev })
    })
    return applied
  }

  async function currentSettings(): Promise<Settings | undefined> {
    return (await db.settings.toCollection().filter(alive).first()) as Settings | undefined
  }

  // Make sure there is an exact rate set for today for every currency in settings.
  async function ensureTodayRates(settings: Settings | undefined): Promise<void> {
    if (!settings) return
    const today = localDate(new Date(), settings.timezone ?? 'Europe/Kyiv')
    const rates = await db.fx_rates.toArray()
    const missing = settings.currencies.some((c) => c !== 'USD' && usdRate(rates, c, today)?.exact !== true)
    if (!missing) return
    const fetched = await remote.fxRates(today, settings.currencies)
    if (fetched.length) await db.fx_rates.bulkPut(fetched)
  }

  /**
   * Transactions saved without an exact rate: fetch rates for their dates and recompute.
   * A row with a local edit (dirty) carries the fix in its own push. A clean row is NOT marked dirty
   * (a whole-row push could undo what the bot did on the server meanwhile): its id goes to the
   * `rate_fix` marker and the fix is sent as a column-scoped patch.
   */
  async function resolvePendingRates(settings: Settings | undefined): Promise<void> {
    const pending = await db.transactions.filter((t) => t.rate_pending && alive(t)).toArray()
    if (pending.length === 0) return
    const dates = [...new Set(pending.map((t) => t.date))].sort()
    for (const date of dates) {
      const currencies = new Set(settings?.currencies ?? [])
      for (const t of pending) if (t.date === date) currencies.add(t.currency)
      const fetched = await remote.fxRates(date, [...currencies])
      if (fetched.length) await db.fx_rates.bulkPut(fetched)
    }
    for (const { id } of pending) {
      // The fetches above took time: re-read the row and recompute from its CURRENT values.
      await db.transaction('rw', db.transactions, db.fx_rates, db.meta, async () => {
        const current = await db.transactions.get(id)
        if (!current || !alive(current) || !current.rate_pending) return
        const found = usdRate(await db.fx_rates.toArray(), current.currency, current.date)
        if (!found) return
        const amount_usd = round2(current.amount * found.rate)
        const rate_pending = !found.exact
        if (found.rate === current.rate_usd && amount_usd === current.amount_usd && rate_pending === current.rate_pending) return
        await db.transactions.put({ ...current, rate_usd: found.rate, amount_usd, rate_pending })
        if (current.dirty === 0 && !rate_pending) {
          const ids = ((await db.meta.get(RATE_FIX_KEY))?.value as string[] | undefined) ?? []
          if (!ids.includes(id)) await db.meta.put({ key: RATE_FIX_KEY, value: [...ids, id] })
        }
      })
    }
  }

  /** Sends the marked rate fixes; returns true when something went out (the server result is then pulled). */
  async function flushRateFixes(): Promise<boolean> {
    const ids = ((await db.meta.get(RATE_FIX_KEY))?.value as string[] | undefined) ?? []
    if (ids.length === 0) return false
    const patches: RatePatch[] = []
    for (const id of ids) {
      const row = await db.transactions.get(id)
      // gone, deleted, pending again (server copy pulled) or edited locally (its push carries the rate): drop
      if (!row || !alive(row) || row.rate_pending || row.dirty !== 0) continue
      patches.push({ id, rate_usd: row.rate_usd, amount_usd: row.amount_usd })
    }
    if (patches.length) await remote.patchRates(patches)
    await db.transaction('rw', db.meta, async () => {
      const now = ((await db.meta.get(RATE_FIX_KEY))?.value as string[] | undefined) ?? []
      await db.meta.put({ key: RATE_FIX_KEY, value: now.filter((id) => !ids.includes(id)) })
    })
    return patches.length > 0
  }

  let running: Promise<SyncResult> | null = null

  async function run(): Promise<SyncResult> {
    let pushed = 0
    let pulled = 0
    let parked = 0
    const errors: string[] = []
    const fxErrors: string[] = []
    const note = (list: string[], e: unknown) => {
      const m = message(e)
      if (!list.includes(m)) list.push(m)
    }

    if (!started) {
      started = true
      try {
        await unparkAll()
      } catch (e) {
        note(errors, e)
      }
    }

    // Every table on its own: one failure must not hold back the others, and pulls always run.
    for (const table of SYNC_TABLES) {
      try {
        const r = await pushTable(table)
        pushed += r.pushed
        parked += r.parked.length
        for (const m of r.parked) note(errors, m)
      } catch (e) {
        note(errors, e)
      }
    }
    for (const table of SYNC_TABLES) {
      try {
        pulled += await pullTable(table)
      } catch (e) {
        note(errors, e)
      }
    }

    let settings: Settings | undefined
    try {
      settings = await currentSettings()
      await ensureTodayRates(settings)
    } catch (e) {
      note(fxErrors, e)
    }
    try {
      await resolvePendingRates(settings)
    } catch (e) {
      note(fxErrors, e)
    }
    try {
      if (await flushRateFixes()) pulled += await pullTable('transactions')
    } catch (e) {
      note(fxErrors, e)
    }

    const out: SyncResult = { pushed, pulled }
    if (parked) out.parked = parked
    if (errors.length) out.error = errors.join('; ')
    if (fxErrors.length) out.fxError = fxErrors.join('; ')
    return out
  }

  function syncOnce(): Promise<SyncResult> {
    running ??= run().finally(() => {
      running = null
    })
    return running
  }

  return { syncOnce }
}
