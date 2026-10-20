import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { localDate } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Account, Base, Settings, SyncTable, Transaction } from '@shared/types.ts'
import type { LocalDb, Row } from './local.ts'

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
  /** Edit a transaction; rate_usd / amount_usd / rate_pending are recomputed from the merged row. */
  updateTransaction(id: string, patch: Partial<NewTransaction>): Promise<Transaction>
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

  /** USD conversion of an amount on a date: zeros + pending when no rate is known at all. */
  async function usdFields(
    amount: number,
    currency: string,
    date: string,
  ): Promise<Pick<Transaction, 'rate_usd' | 'amount_usd' | 'rate_pending'>> {
    const found = usdRate(await db.fx_rates.toArray(), currency, date)
    return {
      rate_usd: found ? found.rate : 0,
      amount_usd: found ? round2(amount * found.rate) : 0,
      rate_pending: found ? !found.exact : true,
    }
  }

  async function buildTransaction(input: NewTransaction): Promise<Transaction> {
    return {
      ...input,
      id: deps.uuid(),
      deleted: false,
      ...(await usdFields(input.amount, input.currency, input.date)),
      created_at: deps.now().toISOString(),
    }
  }

  async function addTransaction(input: NewTransaction): Promise<Transaction> {
    const tx = await buildTransaction(input)
    await db.transactions.put({ ...tx, dirty: 1 })
    deps.onChange()
    return tx
  }

  async function updateTransaction(id: string, patch: Partial<NewTransaction>): Promise<Transaction> {
    const existing = await db.transactions.get(id)
    if (!existing) throw new Error(`Transaction  not found`)
    const merged = { ...existing, ...patch }
    const updated: Row<Transaction> = {
      ...merged,
      ...(await usdFields(merged.amount, merged.currency, merged.date)),
      dirty: 1,
    }
    await db.transactions.put(updated)
    deps.onChange()
    return updated
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

  return { put, remove, addTransaction, updateTransaction, initDefaults }
}

