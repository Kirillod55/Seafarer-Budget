import type { SupabaseClient } from '@supabase/supabase-js'
import { SYNC_TABLES, type FxRate, type SyncTable } from '@shared/types.ts'
import type { Remote } from './sync.ts'

const PUSH_CHUNK = 500
const PAGE = 1000

export interface SupabaseRemote extends Remote {
  /** Calls `cb` on any change of a synced table made elsewhere (Realtime). Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void
}

export function createSupabaseRemote(client: SupabaseClient): SupabaseRemote {
  return {
    async push(table: SyncTable, rows: object[]) {
      const out: { id: string; rev: number }[] = []
      for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
        const { data, error } = await client
          .from(table)
          .upsert(rows.slice(i, i + PUSH_CHUNK), { onConflict: 'id' })
          .select('id, rev')
        if (error) throw new Error(error.message)
        for (const r of data ?? []) out.push({ id: r.id as string, rev: Number(r.rev) })
      }
      return out
    },

    async pull(table: SyncTable, sinceRev: number) {
      const out: object[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client
          .from(table)
          .select('*')
          .gt('rev', sinceRev)
          .order('rev', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        out.push(...(data ?? []))
        if (!data || data.length < PAGE) break
      }
      return out
    },

    async fxRates(date: string) {
      const { data, error } = await client.functions.invoke('fx-rates', { body: { date } })
      if (error) throw new Error(error.message)
      const list: unknown = Array.isArray(data) ? data : (data as { rates?: unknown } | null)?.rates
      return Array.isArray(list) ? (list as FxRate[]) : []
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
