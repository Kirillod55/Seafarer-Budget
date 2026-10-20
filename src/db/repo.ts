import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { localDate } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Account, Base, Settings, SyncTable, Transaction } from '@shared/types.ts'
import type { LocalDb } from './local.ts'

export interface RepoDeps {
  now(): Date
  uuid(): string
  onChange(): void
}

export type NewTransaction = Omit<
  Transaction,
  'id' | 'deleted' | 'rate_usd' | 'amount_usd' | 'rate_pending' | 'created_at'
>

export interface Repo {
  put<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T>
  remove(table: SyncTable, id: string): Promise<void>
  addTransaction(input: NewTransaction): Promise<Transaction>
  initDefaults(
    mode: 'single' | 'multi',
    opening: { currency: string; amount: number; accountName?: string }[],
  ): Promise<void>
}

const MAIN_ACCOUNT = 'Основной'
const OPENING_NOTE = 'Начальный остаток'

export function createRepo(db: LocalDb, deps: RepoDeps): Repo {
  async function write<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T> {
    const t = db.syncTable(table)
    const id = row.id ?? deps.uuid()
    const existing = await t.get(id)
    const merged = {
      ...existing,
      ...row,
      id,
      deleted: row.deleted ?? existing?.deleted ?? false,
      dirty: 1 as const,
    }
    await t.put(merged as never)
    return merged as unknown as T
  }

  async function put<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T> {
    const out = await write<T>(table, row)
    deps.onChange()
    return out
  }

  async function remove(table: SyncTable, id: string): Promise<void> {
    const t = db.syncTable(table)
    const existing = await t.get(id)
    if (!existing) return
    await t.put({ ...existing, deleted: true, dirty: 1 })
    deps.onChange()
  }

  async function buildTransaction(input: NewTransaction): Promise<Transaction> {
    const rates = await db.fx_rates.toArray()
    const found = usdRate(rates, input.currency, input.date)
    const rate_usd = found ? found.rate : 0
    return {
      ...input,
      id: deps.uuid(),
      deleted: false,
      rate_usd,
      amount_usd: found ? round2(input.amount * found.rate) : 0,
      rate_pending: found ? !found.exact : true,
      created_at: deps.now().toISOString(),
    }
  }

  async function addTransaction(input: NewTransaction): Promise<Transaction> {
    const tx = await buildTransaction(input)
    await db.transactions.put({ ...tx, dirty: 1 })
    deps.onChange()
    return tx
  }

  async function initDefaults(
    mode: 'single' | 'multi',
    opening: { currency: string; amount: number; accountName?: string }[],
  ): Promise<void> {
    const settings = await write<Settings>('settings', {
      ...(await db.settings.toCollection().first()),
      ...DEFAULT_SETTINGS,
      accounts_mode: mode,
    })

    for (const c of DEFAULT_CATEGORIES) {
      await write('categories', c)
    }

    // Account names in order of first appearance; single mode has only the main account.
    const names: string[] = []
    const nameOf = (accountName?: string) => (mode === 'single' ? MAIN_ACCOUNT : accountName?.trim() || MAIN_ACCOUNT)
    for (const o of opening) {
      const name = nameOf(o.accountName)
      if (!names.includes(name)) names.push(name)
    }
    if (names.length === 0) names.push(MAIN_ACCOUNT)

    const accountIds = new Map<string, string>()
    for (const [sort, name] of names.entries()) {
      const acc = await write<Account>('accounts', {
        name,
        aliases: [],
        is_default: sort === 0,
        archived: false,
        sort,
      })
      accountIds.set(name, acc.id)
    }

    const date = localDate(deps.now(), settings.timezone)
    for (const o of opening) {
      if (o.amount === 0) continue
      const tx = await buildTransaction({
        kind: 'adjustment',
        amount: o.amount,
        currency: o.currency,
        account_id: accountIds.get(nameOf(o.accountName))!,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date,
        note: OPENING_NOTE,
        source: 'app',
      })
      await db.transactions.put({ ...tx, dirty: 1 })
    }
    deps.onChange()
  }

  return { put, remove, addTransaction, initDefaults }
}

