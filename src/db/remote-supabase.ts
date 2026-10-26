import type { SupabaseClient } from '@supabase/supabase-js'
import { isSoftTable, SYNC_TABLES, type FxRate, type SyncTable } from '@shared/types.ts'
import { RowRejectedError, type PushResult, type RatePatch, type Remote } from './sync.ts'

const PUSH_CHUNK = 500
const PAGE = 1000

export interface SupabaseRemote extends Remote {
  /** Calls `cb` on any change of a synced table made elsewhere (Realtime). Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void
}

/**
 * The server answered and refused the data (constraint, bad value, RLS): a 4xx other than
 * 401 (expired token), 408 (timeout) and 429 (rate limit), which are worth retrying as they are.
 */
function isRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
}

/** The columns a push asks back, and what it makes of them (soft tables also deleted_at / deleted_batch). */
function resultColumns(table: SyncTable): string {
  return isSoftTable(table) ? 'id, rev, deleted, deleted_at, deleted_batch' : 'id, rev, deleted'
}

function toResults(table: SyncTable, data: unknown): PushResult[] {
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const result: PushResult = { id: r.id as string, rev: Number(r.rev), deleted: r.deleted === true }
    if (isSoftTable(table)) {
      result.deleted_at = (r.deleted_at as string | null) ?? null
      result.deleted_batch = (r.deleted_batch as string | null) ?? null
    }
    return result
  })
}

export function createSupabaseRemote(client: SupabaseClient): SupabaseRemote {
  return {
    // The deletion fields come back too: the trigger may keep a deletion over the pushed edit.
    async push(table: SyncTable, rows: object[]) {
      const out: PushResult[] = []
      for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
        const { data, error, status } = await client
          .from(table)
          .upsert(rows.slice(i, i + PUSH_CHUNK), { onConflict: 'id' })
          .select(resultColumns(table))
        if (error) throw isRejection(status) ? new RowRejectedError(error.message) : new Error(error.message)
        out.push(...toResults(table, data))
      }
      return out
    },

    // A column-scoped UPDATE (an upsert would put NULL in the NOT NULL columns it does not send and fail).
    async pushColumns(table: SyncTable, row: object) {
      const { id, ...fields } = row as Record<string, unknown> & { id: string }
      const { data, error, status } = await client.from(table).update(fields).eq('id', id).select(resultColumns(table))
      if (error) throw isRejection(status) ? new RowRejectedError(error.message) : new Error(error.message)
      return toResults(table, data)
    },

    // Keyset paging: an offset would skip rows when a row changes (and gets a new rev) between pages.
    async pull(table: SyncTable, sinceRev: number) {
      const out: object[] = []
      let last = sinceRev
      for (;;) {
        const { data, error } = await client
          .from(table)
          .select('*')
          .gt('rev', last)
          .order('rev', { ascending: true })
          .limit(PAGE)
        if (error) throw new Error(error.message)
        const rows = (data ?? []) as { rev: number }[]
        out.push(...rows)
        if (rows.length < PAGE) break
        last = Number(rows[rows.length - 1].rev)
      }
      return out
    },

    async fxRates(date: string, currencies: string[]) {
      const { data, error } = await client.functions.invoke('fx-rates', { body: { date, currencies } })
      if (error) throw new Error(error.message)
      const list: unknown = Array.isArray(data) ? data : (data as { rates?: unknown } | null)?.rates
      return Array.isArray(list) ? (list as FxRate[]) : []
    },

    async fxRatesBatch(dates: string[], currencies: string[]) {
      const { data, error } = await client.functions.invoke('fx-rates', { body: { dates, currencies } })
      if (error) throw new Error(error.message)
      return Array.isArray(data) ? (data as FxRate[]) : []
    },

    // Only the rate columns, and only while the row is still pending and not in the bin on the server, so a
    // deletion or a category change made by the bot in the meantime is never overwritten, and a binned row
    // is not written at all.
    async patchRates(rows: RatePatch[]) {
      for (const { id, rate_usd, amount_usd } of rows) {
        const { error } = await client
          .from('transactions')
          .update({ rate_usd, amount_usd, rate_pending: false })
          .eq('id', id)
          .eq('rate_pending', true)
          .is('deleted_at', null)
        if (error) throw new Error(error.message)
      }
    },

    subscribe(cb: () => void) {
      const channel = client.channel('seafarer-budget-sync')
      for (const table of SYNC_TABLES) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb())
      }
      channel.subscribe()
      return () => {
        void client.removeChannel(channel)
      }
    },
  }
}
