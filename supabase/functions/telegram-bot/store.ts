// Supabase-backed BotStore (Deno). Uses the service role, which bypasses RLS, so every query
// filters by `user_id = ownerUserId` and every insert sets it explicitly. `rev` is never sent:
// the database trigger stamps it.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { BotStore } from '../_shared/bot.ts'
import { localDate } from '../_shared/dates.ts'
import { nbuUrl, parseNbu } from '../_shared/fx.ts'
import type { Category, FxRate, GoalMove, Settings, Transaction } from '../_shared/types.ts'

const PAGE = 1000
const RATE_ROWS = 600 // ~150 days of UAH/USD/EUR/MDL, plenty for "nearest earlier rate"

export interface StoreOptions {
  /** injectable for tests; defaults to global fetch */
  fetchJson?: (url: string) => Promise<unknown>
  now?: () => Date
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`)
}

// deno-lint-ignore no-explicit-any
function clean<T extends Record<string, any>>(row: T): Omit<T, 'rev' | 'user_id'> {
  const { rev: _rev, user_id: _userId, ...rest } = row
  return rest
}

export function createStore(db: SupabaseClient, ownerUserId: string, opts: StoreOptions = {}): BotStore {
  const fetchJson =
    opts.fetchJson ??
    (async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`NBU responded ${res.status}`)
      return await res.json()
    })
  const now = opts.now ?? (() => new Date())

  /** All live rows of an owner's table, paged past the 1000-row API limit. */
  async function all<T>(table: string): Promise<T[]> {
    const out: T[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from(table)
        .select('*')
        .eq('user_id', ownerUserId)
        .eq('deleted', false)
        .order('rev', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) fail(`read ${table}`, error)
      const rows = (data ?? []) as T[]
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  async function update(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await db.from(table).update(clean(patch)).eq('id', id).eq('user_id', ownerUserId)
    if (error) fail(`update ${table}`, error)
  }

  return {
    async seenUpdate(updateId) {
      const { error } = await db.from('bot_updates').insert({ update_id: updateId })
      if (!error) return false
      if (error.code === '23505') return true // unique violation: already processed
      fail('bot_updates insert', error)
    },

    async settings() {
      const { data, error } = await db
        .from('settings')
        .select('*')
        .eq('user_id', ownerUserId)
        .eq('deleted', false)
        .order('rev', { ascending: false })
        .limit(1)
      if (error) fail('read settings', error)
      return ((data ?? [])[0] as Settings | undefined) ?? null
    },

    categories: () => all('categories'),
    accounts: () => all('accounts'),
    goals: () => all('goals'),
    goalMoves: () => all('goal_moves'),
    limits: () => all('limits'),
    transactions: () => all<Transaction>('transactions'),

    async rates() {
      const { data, error } = await db
        .from('fx_rates')
        .select('date,currency,uah_per_unit')
        .order('date', { ascending: false })
        .limit(RATE_ROWS)
      if (error) fail('read fx_rates', error)
      const rows = ((data ?? []) as FxRate[]).map((r) => ({ ...r, uah_per_unit: Number(r.uah_per_unit) }))

      // Make sure today's rate is there (the daily job may not have run yet). Never fatal.
      try {
        const s = await this.settings()
        const today = localDate(now(), s?.timezone ?? 'Europe/Kyiv')
        if (!rows.some((r) => r.currency === 'USD' && r.date === today)) {
          const fetched = parseNbu(await fetchJson(nbuUrl(today)), s?.currencies ?? ['UAH', 'USD', 'EUR', 'MDL'])
          if (fetched.length > 0) {
            const { error: upErr } = await db.from('fx_rates').upsert(fetched, { onConflict: 'date,currency' })
            if (upErr) console.error('fx_rates upsert failed:', upErr.message)
            rows.push(...fetched)
          }
        }
      } catch (e) {
        console.error('could not fetch today rates:', e instanceof Error ? e.message : String(e))
      }
      return rows
    },

    async insertTx(t: Transaction) {
      const { error } = await db.from('transactions').insert({ ...clean(t), user_id: ownerUserId })
      if (error) fail('insert transaction', error)
    },
    updateTx: (id, patch: Partial<Transaction>) => update('transactions', id, patch),

    async insertGoalMove(m: GoalMove) {
      const { error } = await db.from('goal_moves').insert({ ...clean(m), user_id: ownerUserId })
      if (error) fail('insert goal_move', error)
    },
    updateCategory: (id, patch: Partial<Category>) => update('categories', id, patch),
  }
}
