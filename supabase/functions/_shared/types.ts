export interface Base {
  id: string
  user_id?: string
  rev?: number
  /** The rev the writer had seen when it made the edit; only the server's set_rev() reads it. Not sent yet. */
  base_rev?: number | null
  deleted: boolean
}

/** Soft delete with a 24 h undo: `deleted_at` set = in the bin, `deleted_batch` groups one delete action. */
export interface SoftDeletable {
  deleted_at: string | null
  deleted_batch: string | null
}

export type Author = 'owner' | 'partner'

export interface Settings extends Base {
  base_currency: string
  default_currency: string
  currencies: string[]
  accounts_mode: 'single' | 'multi'
  status: 'home' | 'contract'
  next_contract_date: string | null
  contract_start_date: string | null
  contract_end_date: string | null
  salary_lag_days: number
  timezone: string
  reserve_usd: number
  partner_name: string | null
  partner_seen_at: string | null
  remind_after_days: 0 | 2 | 3 | 5 | 7
  last_reminder_at: string | null
  keepalive_at: string | null
  daily_summary_owner: boolean
  daily_summary_partner: boolean
}

export interface Account extends Base {
  name: string
  aliases: string[]
  is_default: boolean
  archived: boolean
  sort: number
}

export interface Category extends Base, SoftDeletable {
  name: string
  kind: 'expense' | 'income'
  icon: string
  keywords: string[]
  archived: boolean
  sort: number
  color: string | null
  glyph: string | null
}

export type TxKind = 'expense' | 'income' | 'transfer' | 'exchange' | 'adjustment'

export interface Transaction extends Base, SoftDeletable {
  kind: TxKind
  amount: number
  currency: string
  rate_usd: number
  amount_usd: number
  rate_pending: boolean
  account_id: string
  to_account_id: string | null
  to_amount: number | null
  to_currency: string | null
  category_id: string | null
  date: string
  note: string
  source: 'app' | 'bot'
  created_at: string
  author: Author
  archived: boolean
}

export interface Goal extends Base, SoftDeletable {
  name: string
  target_usd: number
  deadline: string | null
  archived: boolean
}

export interface GoalMove extends Base {
  goal_id: string
  amount_usd: number
  date: string
  note: string
  author: Author
  source: 'app' | 'bot'
  created_at: string
}

export interface Limit extends Base, SoftDeletable {
  category_id: string
  monthly_usd: number
}

export interface FxRate {
  date: string
  currency: string
  uah_per_unit: number
}

export const SYNC_TABLES = [
  'settings',
  'accounts',
  'categories',
  'transactions',
  'goals',
  'goal_moves',
  'limits',
] as const

export type SyncTable = typeof SYNC_TABLES[number]

/** Synced tables with `deleted_at` / `deleted_batch` (the 24 h undo bin); the others only know the final `deleted`. */
export const SOFT_TABLES = ['categories', 'transactions', 'goals', 'limits'] as const satisfies readonly SyncTable[]

export type SoftTable = typeof SOFT_TABLES[number]

export function isSoftTable(table: SyncTable): table is SoftTable {
  return (SOFT_TABLES as readonly SyncTable[]).includes(table)
}
