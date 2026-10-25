import Dexie, { type Table } from 'dexie'
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import type {
  Account,
  Category,
  FxRate,
  Goal,
  GoalMove,
  Limit,
  Settings,
  SyncTable,
  Transaction,
} from '@shared/types.ts'

// Booleans cannot be indexed in IndexedDB, so `dirty` is a number:
// 0 = in sync, 1 = waiting to be pushed, 2 = parked (the server refused it; retried after an edit or on app start).
// `_changed` (settings only, local-only): the fields edited since the last successful push; sync sends only
// those for a row the server already has, so the bot's / another device's changes to other fields survive.
export type Row<T> = T & { dirty: 0 | 1 | 2; _changed?: string[] }

export interface MetaRow {
  key: string
  value: unknown
}

export class LocalDb extends Dexie {
  settings!: Table<Row<Settings>, string>
  accounts!: Table<Row<Account>, string>
  categories!: Table<Row<Category>, string>
  transactions!: Table<Row<Transaction>, string>
  goals!: Table<Row<Goal>, string>
  goal_moves!: Table<Row<GoalMove>, string>
  limits!: Table<Row<Limit>, string>
  fx_rates!: Table<FxRate, [string, string]>
  meta!: Table<MetaRow, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
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
    // v2 (Seafarer Budget 1.1): same indexes; the upgrade fills the new fields into old rows.
    this.version(2)
      .stores({
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
      .upgrade(async (tx) => {
        const fill = (row: Record<string, unknown>, defaults: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(defaults)) if (row[k] === undefined) row[k] = v
        }
        const soft = { deleted_at: null, deleted_batch: null }
        const newSettings = {
          reserve_usd: DEFAULT_SETTINGS.reserve_usd,
          partner_name: DEFAULT_SETTINGS.partner_name,
          partner_seen_at: DEFAULT_SETTINGS.partner_seen_at,
          remind_after_days: DEFAULT_SETTINGS.remind_after_days,
          last_reminder_at: DEFAULT_SETTINGS.last_reminder_at,
          keepalive_at: DEFAULT_SETTINGS.keepalive_at,
          daily_summary_owner: DEFAULT_SETTINGS.daily_summary_owner,
          daily_summary_partner: DEFAULT_SETTINGS.daily_summary_partner,
        }
        await tx.table('settings').toCollection().modify((r) => fill(r, newSettings))
        await tx.table('transactions').toCollection().modify((r) => fill(r, { author: 'owner', archived: false, ...soft }))
        await tx.table('goals').toCollection().modify((r) => fill(r, soft))
        await tx.table('limits').toCollection().modify((r) => fill(r, soft))
        await tx.table('categories').toCollection().modify((r) => fill(r, { color: null, glyph: null, ...soft }))
        await tx.table('goal_moves').toCollection().modify((r) =>
          // Same value as the SQL backfill: noon UTC of the move's own date.
          fill(r, { author: 'owner', source: 'app', created_at: `${r.date}T12:00:00.000Z` }),
        )
      })
  }

  /** Untyped access to a synced table by name. */
  syncTable(table: SyncTable): Table<Row<Record<string, unknown> & { id: string; deleted: boolean }>, string> {
    return this.table(table)
  }
}

export function createDb(name: string): LocalDb {
  return new LocalDb(name)
}

export const db: LocalDb = createDb('seafarer-budget')

