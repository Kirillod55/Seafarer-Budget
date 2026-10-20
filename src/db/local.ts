import Dexie, { type Table } from 'dexie'
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
export type Row<T> = T & { dirty: 0 | 1 | 2 }

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

