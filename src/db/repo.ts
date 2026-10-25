import { alive } from '@shared/alive.ts'
import type { ImportRow } from '@shared/csv.ts'
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { localDate } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import {
  isSoftTable,
  SOFT_TABLES,
  type Account,
  type Base,
  type Category,
  type FxRate,
  type Settings,
  type SoftDeletable,
  type SoftTable,
  type SyncTable,
  type Transaction,
} from '@shared/types.ts'
import { selectForWipe, type WipeKind, type WipeScope } from '@shared/wipe.ts'
import type { LocalDb, Row } from './local.ts'

export interface RepoDeps {
  now(): Date
  uuid(): string
  onChange(): void
}

export type NewTransaction = Omit<
  Transaction,
  | 'id'
  | 'deleted'
  | 'rate_usd'
  | 'amount_usd'
  | 'rate_pending'
  | 'created_at'
  | 'author'
  | 'archived'
  | 'deleted_at'
  | 'deleted_batch'
> &
  Partial<Pick<Transaction, 'author' | 'archived'>>

export interface Repo {
  put<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T>
  /**
   * Soft delete into the 24 h undo bin (deleted_at = now, deleted_batch = a new batch); returns the batch
   * for «Отменить» / restore(). Settings, accounts and goal moves have no bin: their removal stays final.
   */
  remove(table: SyncTable, id: string): Promise<string>
  /** Hide a record from the lists (it still counts in the balance and reports). */
  setArchived(id: string, archived: boolean): Promise<void>
  /** «Удалить записи…»: live records of the kind in the period go to the bin as one batch. */
  wipe(scope: WipeScope, kind: WipeKind): Promise<{ batch: string; count: number }>
  /**
   * «Удалить все данные…»: records, goals, limits and own categories (not a standard name) go to the bin as one
   * batch; settings, accounts and standard categories stay. `count` = rows marked in all tables.
   */
  wipeAll(): Promise<{ batch: string; count: number }>
  /** Takes the batch out of the bin; rows deleted for good (`deleted`) meanwhile stay deleted. Returns rows restored. */
  restore(batch: string): Promise<number>
  /**
   * «Загрузить из CSV»: adds the rows as new records tagged deleted_batch = batch (deleted_at null), so
   * markBatchDeleted(batch) undoes the import. Categories it creates carry the same batch.
   */
  importRows(rows: ImportRow[], opts: { createCategories: boolean }): Promise<{ batch: string; count: number }>
  /** Puts the live rows of a batch into the bin (undo of an import). Returns rows marked. */
  markBatchDeleted(batch: string): Promise<number>
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
const STANDARD_CATEGORIES = new Set(DEFAULT_CATEGORIES.map((c) => c.name))
/** Where an imported record without a known category goes. */
const OTHER_CATEGORY: Record<ImportRow['kind'], string> = { expense: 'Прочее', income: 'Прочий доход' }
const IMPORTED_CATEGORY_ICON = '🏷️'

type SoftRow = Row<Base & SoftDeletable & Record<string, unknown>>

/** USD conversion of an amount on a date: zeros + pending when no rate is known at all. */
function usdFieldsFrom(
  rates: FxRate[],
  amount: number,
  currency: string,
  date: string,
): Pick<Transaction, 'rate_usd' | 'amount_usd' | 'rate_pending'> {
  const found = usdRate(rates, currency, date)
  return {
    rate_usd: found ? found.rate : 0,
    amount_usd: found ? round2(amount * found.rate) : 0,
    rate_pending: found ? !found.exact : true,
  }
}

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

  const softTable = (table: SoftTable) => db.table<SoftRow, string>(table)

  async function remove(table: SyncTable, id: string): Promise<string> {
    const batch = deps.uuid()
    const t = db.syncTable(table)
    const existing = await t.get(id)
    if (!existing) return batch
    if (isSoftTable(table)) {
      await t.put({ ...existing, deleted_at: deps.now().toISOString(), deleted_batch: batch, dirty: 1 })
    } else {
      await t.put({ ...existing, deleted: true, dirty: 1 })
    }
    deps.onChange()
    return batch
  }

  async function setArchived(id: string, archived: boolean): Promise<void> {
    const existing = await db.transactions.get(id)
    if (!existing) throw new Error(`Transaction ${id} not found`)
    await db.transactions.put({ ...existing, archived, dirty: 1 })
    deps.onChange()
  }

  async function today(): Promise<string> {
    const settings = await db.settings.filter(alive).first()
    return localDate(deps.now(), settings?.timezone ?? DEFAULT_SETTINGS.timezone)
  }

  const binned = <T extends SoftRow>(row: T, at: string, batch: string): T => ({
    ...row,
    deleted_at: at,
    deleted_batch: batch,
    dirty: 1,
  })

  async function wipe(scope: WipeScope, kind: WipeKind): Promise<{ batch: string; count: number }> {
    const batch = deps.uuid()
    const at = deps.now().toISOString()
    const date = await today()
    let count = 0
    await db.transaction('rw', db.transactions, async () => {
      const chosen = selectForWipe(await db.transactions.toArray(), scope, kind, date)
      await db.transactions.bulkPut(chosen.map((t) => binned(t as Row<Transaction> & SoftRow, at, batch)))
      count = chosen.length
    })
    if (count) deps.onChange()
    return { batch, count }
  }

  async function wipeAll(): Promise<{ batch: string; count: number }> {
    const batch = deps.uuid()
    const at = deps.now().toISOString()
    let count = 0
    await db.transaction('rw', SOFT_TABLES.map(softTable), async () => {
      for (const table of SOFT_TABLES) {
        const rows = (await softTable(table).toArray()).filter(
          (r) => alive(r) && !(table === 'categories' && STANDARD_CATEGORIES.has(r.name as string)),
        )
        await softTable(table).bulkPut(rows.map((r) => binned(r, at, batch)))
        count += rows.length
      }
    })
    if (count) deps.onChange()
    return { batch, count }
  }

  /** Rewrites the rows of a batch that pass `pick`, in every table with a bin; returns how many. */
  async function updateBatch(batch: string, pick: (r: SoftRow) => boolean, change: (r: SoftRow) => SoftRow): Promise<number> {
    let count = 0
    await db.transaction('rw', SOFT_TABLES.map(softTable), async () => {
      for (const table of SOFT_TABLES) {
        const rows = await softTable(table)
          .filter((r) => r.deleted_batch === batch && pick(r))
          .toArray()
        await softTable(table).bulkPut(rows.map(change))
        count += rows.length
      }
    })
    if (count) deps.onChange()
    return count
  }

  // `base_rev = rev` goes out with the push (sync.ts toWire): the server lifts deleted_at only for a writer that saw it.
  function restore(batch: string): Promise<number> {
    return updateBatch(
      batch,
      (r) => !r.deleted && r.deleted_at !== null,
      (r) => ({ ...r, deleted_at: null, deleted_batch: null, dirty: 1 }),
    )
  }

  function markBatchDeleted(batch: string): Promise<number> {
    const at = deps.now().toISOString()
    return updateBatch(batch, alive, (r) => binned(r, at, batch))
  }

  async function importRows(
    rows: ImportRow[],
    opts: { createCategories: boolean },
  ): Promise<{ batch: string; count: number }> {
    const batch = deps.uuid()
    if (rows.length === 0) return { batch, count: 0 }

    const accounts = (await db.accounts.toArray()).filter((a) => alive(a) && !a.archived).sort((a, b) => a.sort - b.sort)
    const fallbackAccount = accounts.find((a) => a.is_default) ?? accounts[0]
    if (!fallbackAccount) throw new Error('No account to import into')
    const accountId = (name: string) => accounts.find((a) => a.name === name.trim())?.id ?? fallbackAccount.id

    const allCategories = await db.categories.toArray()
    const categories: Category[] = allCategories.filter(alive)
    let nextSort = Math.max(-1, ...allCategories.map((c) => c.sort)) + 1
    const created: Row<Category>[] = []
    const byName = (name: string, kind: ImportRow['kind']) =>
      categories.find((c) => c.name.trim() === name && c.kind === kind) ?? categories.find((c) => c.name.trim() === name)
    const categoryId = (row: ImportRow): string | null => {
      const name = row.category.trim()
      const found = name === '' ? undefined : byName(name, row.kind)
      if (found) return found.id
      if (name !== '' && opts.createCategories) {
        const category: Row<Category> = {
          id: deps.uuid(),
          name,
          kind: row.kind,
          icon: IMPORTED_CATEGORY_ICON,
          keywords: [],
          archived: false,
          sort: nextSort++,
          color: null,
          glyph: null,
          deleted: false,
          deleted_at: null,
          deleted_batch: batch,
          dirty: 1,
        }
        created.push(category)
        categories.push(category)
        return category.id
      }
      return byName(OTHER_CATEGORY[row.kind], row.kind)?.id ?? null
    }

    const rates = await db.fx_rates.toArray()
    const txs: Row<Transaction>[] = rows.map((row) => ({
      ...buildFrom(rates, {
        kind: row.kind,
        amount: row.amount,
        currency: row.currency,
        account_id: accountId(row.account),
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: categoryId(row),
        date: row.date,
        note: row.note,
        source: 'app',
        author: row.author,
      }),
      deleted_batch: batch,
      dirty: 1,
    }))

    await db.transaction('rw', db.transactions, db.categories, async () => {
      await db.categories.bulkPut(created)
      await db.transactions.bulkPut(txs)
    })
    deps.onChange()
    return { batch, count: txs.length }
  }

  async function usdFields(
    amount: number,
    currency: string,
    date: string,
  ): Promise<Pick<Transaction, 'rate_usd' | 'amount_usd' | 'rate_pending'>> {
    return usdFieldsFrom(await db.fx_rates.toArray(), amount, currency, date)
  }

  function buildFrom(rates: FxRate[], input: NewTransaction): Transaction {
    return {
      author: 'owner',
      archived: false,
      ...input,
      id: deps.uuid(),
      deleted: false,
      deleted_at: null,
      deleted_batch: null,
      ...usdFieldsFrom(rates, input.amount, input.currency, input.date),
      created_at: deps.now().toISOString(),
    }
  }

  async function buildTransaction(input: NewTransaction): Promise<Transaction> {
    return buildFrom(await db.fx_rates.toArray(), input)
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

  return {
    put,
    remove,
    setArchived,
    wipe,
    wipeAll,
    restore,
    importRows,
    markBatchDeleted,
    addTransaction,
    updateTransaction,
    initDefaults,
  }
}

