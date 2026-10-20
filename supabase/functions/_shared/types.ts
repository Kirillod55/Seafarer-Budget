export interface Base {
  id: string
  user_id?: string
  rev?: number
  deleted: boolean
}

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
}

export interface Account extends Base {
  name: string
  aliases: string[]
  is_default: boolean
  archived: boolean
  sort: number
}

export interface Category extends Base {
  name: string
  kind: 'expense' | 'income'
  icon: string
  keywords: string[]
  archived: boolean
  sort: number
}

export type TxKind = 'expense' | 'income' | 'transfer' | 'exchange' | 'adjustment'

export interface Transaction extends Base {
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
}

export interface Goal extends Base {
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
}

export interface Limit extends Base {
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
