// Supabase-backed BotStore (Deno). Uses the service role, which bypasses RLS, so every query
// filters by `user_id = ownerUserId` and every insert sets it explicitly. `rev` is never sent:
// the database trigger stamps it.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { BotStore } from '../_shared/bot.ts'
import { localDate } from '../_shared/dates.ts'
import { loadBankRates } from '../_shared/bankRates.ts'
import { DEFAULT_SETTINGS } from '../_shared/defaults.ts'
import { BNM_PREFIX, bnmUrl, nbuUrl, parseNbu, parseBnm } from '../_shared/fx.ts'
import { SOFT_TABLES } from '../_shared/types.ts'
import type { Category, FxRate, GoalMove, Settings, Transaction } from '../_shared/types.ts'

const PAGE = 1000
const RATE_ROWS = 600 // ~150 days of UAH/USD/EUR/MDL, plenty for "nearest earlier rate"
const FX_TIMEOUT_MS = 10_000 // a hung bank must not hang the webhook

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`)
}

// deno-lint-ignore no-explicit-any
function clean<T extends Record<string, any>>(row: T): Omit<T, 'rev' | 'user_id'> {
  const { rev: _rev, user_id: _userId, ...rest } = row
  return rest
}

export function createStore(db: SupabaseClient, ownerUserId: string): BotStore {
  const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) })

  /**
   * All live rows of an owner's table, paged past the 1000-row API limit. Live = not deleted for good
   * and, on the soft tables, not in the 24 h undo bin (`deleted_at is null`); `bin` reads the bin instead.
   */
  async function all<T>(table: string, bin = false): Promise<T[]> {
    const out: T[] = []
    const soft = (SOFT_TABLES as readonly string[]).includes(table)
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select('*').eq('user_id', ownerUserId).eq('deleted', false)
      if (soft) q = bin ? q.not('deleted_at', 'is', null) : q.is('deleted_at', null)
      const { data, error } = await q
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

    async saveDraft(updateId, draft) {
      const { error } = await db.from('bot_updates').update({ draft }).eq('update_id', updateId)
      if (error) fail('save draft', error)
    },

    async takeDraft(updateId) {
      const { data, error } = await db.from('bot_updates').select('draft').eq('update_id', updateId).limit(1)
      if (error) fail('read draft', error)
      const row = (data ?? [])[0] as { draft: unknown } | undefined
      if (!row) return null
      if (row.draft === null) return 'used'
      // taken once: only the update that clears a still-present draft gets it (a double tap gets 'used')
      const { data: taken, error: takeErr } = await db.from('bot_updates').update({ draft: null })
        .eq('update_id', updateId).not('draft', 'is', null).select('update_id')
      if (takeErr) fail('take draft', takeErr)
      return (taken ?? []).length ? row.draft : 'used'
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

      // Make sure today's rates are there (the daily job may not have run yet): the NBU's for money, the Moldovan
      // bank's only for /currency. Never fatal.
      const s = await this.settings().catch(() => null)
      const today = localDate(new Date(), s?.timezone ?? DEFAULT_SETTINGS.timezone)
      const fill = async (what: string, has: (currency: string) => boolean, load: () => Promise<FxRate[]>) => {
        if (rows.some((r) => r.date === today && has(r.currency))) return
        try {
          const fetched = await load()
          if (fetched.length === 0) return
          const { error: upErr } = await db.from('fx_rates').upsert(fetched, { onConflict: 'date,currency' })
          if (upErr) console.error('fx_rates upsert failed:', upErr.message)
          rows.push(...fetched)
        } catch (e) {
          console.error(`could not fetch ${what} rates:`, e instanceof Error ? e.message : String(e))
        }
      }
      await fill('NBU', (c) => c === 'USD', async () => {
        const res = await get(nbuUrl(today))
        if (!res.ok) throw new Error(`NBU responded ${res.status}`)
        return parseNbu(await res.json(), s?.currencies ?? DEFAULT_SETTINGS.currencies)
      })
      await fill('BNM', (c) => c.startsWith(BNM_PREFIX), async () => {
        const res = await get(bnmUrl(today))
        return res.ok ? parseBnm(await res.text(), today) : []
      })
      return rows
    },

    bankRates: () => loadBankRates(),

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

    async insert(table, row) {
      const { error } = await db.from(table).insert({ ...clean(row), user_id: ownerUserId })
      if (error) fail(`insert ${table}`, error)
    },
    update: (table, id, patch) => update(table, id, patch as Record<string, unknown>),
    binnedTransactions: () => all<Transaction>('transactions', true),
    binned: (table) => all(table, true),

    async updateMany(table, ids, patch) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await db.from(table).update(clean(patch as Record<string, unknown>)).in('id', ids.slice(i, i + 200)).eq('user_id', ownerUserId)
        if (error) fail(`update ${table}`, error)
      }
    },
  }
}
