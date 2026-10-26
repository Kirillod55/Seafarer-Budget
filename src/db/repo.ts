import { alive } from '@shared/alive.ts'
import { balances } from '@shared/calc.ts'
import { resolveAccount, type ImportRow } from '@shared/csv.ts'
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { addDays, localDate } from '@shared/dates.ts'
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
   * for «Отменить» / restore(). null: no such row, a row deleted for good, a row already in the bin (it keeps
   * its own deleted_at and batch, nothing is written; returning that batch would let «Отменить» bring back a
   * whole «delete period»), or a table without a bin (settings, accounts and goal moves, whose removal stays final).
   */
  remove(table: SyncTable, id: string): Promise<string | null>
  /**
   * «Удалить» a category (spec §4 «Категории»): one batch bins the category and its limits, and its records move to
   * «Прочее» / «Прочий доход» (archived and binned records too). restore(batch) brings back the category, the limit
   * and the records' category — except a record moved elsewhere meanwhile. null: no such category, already in the
   * bin or deleted for good, or «Прочее» / «Прочий доход» themselves (they cannot be removed).
   */
  removeCategory(id: string): Promise<string | null>
  /**
   * «Удалить» an archived account in «Архив» (spec §4): `deleted = true`, final (accounts have no undo bin). Checked
   * when it is written, not when it was asked for: only an alive, archived, non-default account whose balance is zero
   * in every currency (live records, archived ones included; binned ones not). false = refused, nothing written.
   */
  removeEmptyAccount(id: string): Promise<boolean>
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
  /**
   * The wizard's «Остаток» step on its own (after «Удалить все данные», spec §4): opening balances as adjustments
   * («Начальный остаток», dated yesterday — spec §2) on the default account — or the first active one by sort, or a new «Основной»
   * when there is none. Settings and the other accounts are not touched (initDefaults would overwrite them); zero
   * amounts are skipped.
   */
  addOpening(opening: { currency: string; amount: number }[]): Promise<void>
}

const MAIN_ACCOUNT = 'Основной'
/** below this (cents rounding) a currency balance is zero */
export const EMPTY_BALANCE = 0.005
const OPENING_NOTE = 'Начальный остаток'
const STANDARD_CATEGORIES = new Set(DEFAULT_CATEGORIES.map((c) => c.name))
/** Where an imported record without a known category goes. */
type CategoryKind = Category['kind']
const OTHER_CATEGORY: Record<CategoryKind, string> = { expense: 'Прочее', income: 'Прочий доход' }
const IMPORTED_CATEGORY_ICON = '🏷️'
/** meta key of a category removal's record moves, for restore(batch) (local only: the undo lives on this device) */
const movedKey = (batch: string) => `moved:${batch}`
interface CategoryMoves {
  from: string
  to: string | null
  ids: string[]
  at: string
}
/** the undo bin lasts 24 h: older move lists are dropped */
const MOVES_TTL_MS = 24 * 60 * 60 * 1000

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

/** Keys that are not settings content: identity, server bookkeeping and local sync state. */
const NOT_CONTENT = new Set(['id', 'rev', 'user_id', 'base_rev', 'deleted_rev', 'dirty', '_changed'])

/**
 * Settings only (see Row._changed in local.ts): the fields `next` changes against `existing`, added to the
 * ones still waiting to be pushed. undefined = the row goes out whole: a new row, or one edited before the
 * fields were tracked (its earlier edit is not known field by field).
 */
function changedFields(
  table: SyncTable,
  existing: (Record<string, unknown> & { dirty?: number; _changed?: string[] }) | undefined,
  next: Record<string, unknown>,
): string[] | undefined {
  if (table !== 'settings' || !existing) return undefined
  const pending = existing.dirty !== 0
  if (pending && !Array.isArray(existing._changed)) return undefined
  const fields = pending ? [...existing._changed!] : []
  for (const k of Object.keys(next)) {
    if (NOT_CONTENT.has(k) || fields.includes(k)) continue
    if (JSON.stringify(existing[k] ?? null) !== JSON.stringify(next[k] ?? null)) fields.push(k)
  }
  return fields
}

/** `row` with its `_changed` set to `fields` (or without it when the row goes out whole). */
function withChanged<R extends Record<string, unknown>>(row: R, fields: string[] | undefined): R {
  const { _changed: _old, ...rest } = row
  return (fields ? { ...rest, _changed: fields } : rest) as unknown as R
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
    const out = withChanged(merged, changedFields(table, existing, merged))
    await t.put(out as never)
    return out as unknown as T
  }

  async function put<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T> {
    const out = await write<T>(table, row)
    deps.onChange()
    return out
  }

  const softTable = (table: SoftTable) => db.table<SoftRow, string>(table)

  async function remove(table: SyncTable, id: string): Promise<string | null> {
    const t = db.syncTable(table)
    const existing = await t.get(id)
    if (!existing) return null
    if (!isSoftTable(table)) {
      const next = { ...existing, deleted: true, dirty: 1 as const }
      await t.put(withChanged(next, changedFields(table, existing, next)))
      deps.onChange()
      return null
    }
    const row = existing as unknown as SoftRow
    if (row.deleted) return null // deleted for good: nothing to undo
    if (row.deleted_at) return null // already in the bin: it stays in its own batch, nothing to undo here
    const batch = deps.uuid()
    await t.put({ ...existing, deleted_at: deps.now().toISOString(), deleted_batch: batch, dirty: 1 })
    deps.onChange()
    return batch
  }

  async function removeEmptyAccount(id: string): Promise<boolean> {
    let done = false
    await db.transaction('rw', db.accounts, db.transactions, async () => {
      const account = await db.accounts.get(id)
      if (!account || !alive(account) || !account.archived || account.is_default) return
      const txs = await db.transactions.filter((t) => alive(t) && (t.account_id === id || t.to_account_id === id)).toArray()
      // cents: a balance this close to zero is zero
      if (Object.values(balances(txs, id)).some((v) => Math.abs(v) >= EMPTY_BALANCE)) return
      await db.accounts.put({ ...account, deleted: true, dirty: 1 })
      done = true
    })
    if (done) deps.onChange()
    return done
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
  async function updateBatch(
    batch: string,
    pick: (r: SoftRow) => boolean,
    change: (r: SoftRow) => SoftRow,
    notify = true,
  ): Promise<number> {
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
    if (count && notify) deps.onChange()
    return count
  }

  // `base_rev = rev` goes out with the push (sync.ts toWire): the server lifts deleted_at only for a writer that saw it.
  // A category removal's batch also takes its records back from «Прочее» (those still there), in the same transaction.
  async function restore(batch: string): Promise<number> {
    let count = 0
    await db.transaction('rw', [...SOFT_TABLES.map(softTable), db.meta], async () => {
      count = await updateBatch(
        batch,
        (r) => !r.deleted && r.deleted_at !== null,
        (r) => ({ ...r, deleted_at: null, deleted_batch: null, dirty: 1 }),
        false,
      )
      const moved = (await db.meta.get(movedKey(batch)))?.value as CategoryMoves | undefined
      if (!moved) return
      const rows = (await db.transactions.bulkGet(moved.ids)).filter(
        (t): t is Row<Transaction> => !!t && !t.deleted && t.category_id === moved.to,
      )
      await db.transactions.bulkPut(rows.map((t) => ({ ...t, category_id: moved.from, dirty: 1 as const })))
      await db.meta.delete(movedKey(batch))
      count += rows.length
    })
    if (count) deps.onChange()
    return count
  }

  async function removeCategory(id: string): Promise<string | null> {
    const batch = deps.uuid()
    const at = deps.now().toISOString()
    let done = false
    await db.transaction('rw', [db.categories, db.limits, db.transactions, db.meta], async () => {
      const category = await db.categories.get(id)
      if (!category || category.deleted || category.deleted_at) return
      if (category.name === OTHER_CATEGORY[category.kind]) return
      const other = (await db.categories.toArray()).find(
        (c) => alive(c) && c.id !== id && c.kind === category.kind && c.name === OTHER_CATEGORY[category.kind],
      )
      const to = other?.id ?? null
      await db.categories.put(binned(category as unknown as SoftRow, at, batch) as never)
      const limits = await db.limits.filter((l) => l.category_id === id && alive(l)).toArray()
      await db.limits.bulkPut(limits.map((l) => binned(l as unknown as SoftRow, at, batch)) as never)
      const txs = await db.transactions.filter((t) => t.category_id === id && !t.deleted).toArray()
      await db.transactions.bulkPut(txs.map((t) => ({ ...t, category_id: to, dirty: 1 as const })))
      // forget the moves of removals whose undo bin has run out
      const stale = (await db.meta.filter((m) => m.key.startsWith('moved:')).toArray()).filter(
        (m) => Date.parse((m.value as CategoryMoves).at) < deps.now().getTime() - MOVES_TTL_MS,
      )
      await db.meta.bulkDelete(stale.map((m) => m.key))
      const moves: CategoryMoves = { from: id, to, ids: txs.map((t) => t.id), at }
      await db.meta.put({ key: movedKey(batch), value: moves })
      done = true
    })
    if (!done) return null
    deps.onChange()
    return batch
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

    // «Счёт» / «Счёт куда» by exact name (archived accounts too), else the default account (csv.ts resolveAccount)
    const accounts = await db.accounts.toArray()
    if (!resolveAccount(accounts, '')) throw new Error('No account to import into')
    const accountId = (name: string) => resolveAccount(accounts, name)!.id

    const allCategories = await db.categories.toArray()
    const categories: Category[] = allCategories.filter(alive)
    let nextSort = Math.max(-1, ...allCategories.map((c) => c.sort)) + 1
    const created: Row<Category>[] = []
    // names compare trimmed and case-insensitively, as in planImport
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    const byName = (name: string, kind: CategoryKind) =>
      categories.find((c) => same(c.name, name) && c.kind === kind) ?? categories.find((c) => same(c.name, name))
    const categoryId = (row: ImportRow): string | null => {
      if (row.kind !== 'expense' && row.kind !== 'income') return null // corrections, transfers, exchanges
      const kind = row.kind
      const name = row.category.trim()
      const found = name === '' ? undefined : byName(name, kind)
      if (found) return found.id
      if (name !== '' && opts.createCategories) {
        const category: Row<Category> = {
          id: deps.uuid(),
          name,
          kind,
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
      return byName(OTHER_CATEGORY[kind], kind)?.id ?? null
    }

    const rates = await db.fx_rates.toArray()
    const txs: Row<Transaction>[] = rows.map((row) => {
      const from = accountId(row.account)
      // transfer: onto «Счёт куда»; exchange: «Счёт куда» or, as the app saves it, the same account
      const to =
        row.kind === 'transfer' ? accountId(row.toAccount) : row.kind === 'exchange' ? (row.toAccount ? accountId(row.toAccount) : from) : null
      const exchange = row.kind === 'exchange'
      return {
        ...buildFrom(rates, {
          kind: row.kind,
          amount: row.amount,
          currency: row.currency,
          account_id: from,
          to_account_id: to,
          to_amount: exchange ? row.toAmount : null,
          to_currency: exchange ? row.toCurrency : null,
          category_id: categoryId(row),
          date: row.date,
          note: row.note,
          source: 'app',
          author: row.author,
        }),
        deleted_batch: batch,
        dirty: 1,
      }
    })

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
      ...input,
      // after the spread: an explicit `undefined` in the input must not wipe the defaults
      author: input.author ?? 'owner',
      archived: input.archived ?? false,
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

    // dated yesterday: an opening balance is money held at the start of today, so the morning balance counts it (spec §2)
    const date = addDays(localDate(deps.now(), settings.timezone), -1)
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

  async function addOpening(opening: { currency: string; amount: number }[]): Promise<void> {
    const date = addDays(await today(), -1) // as in initDefaults: part of this morning's balance (spec §2)
    const rates = await db.fx_rates.toArray()
    await db.transaction('rw', db.accounts, db.transactions, async () => {
      const active = (await db.accounts.filter((a) => alive(a) && !a.archived).toArray()).sort((a, b) => a.sort - b.sort)
      const account =
        active.find((a) => a.is_default) ??
        active[0] ??
        (await write<Account>('accounts', { name: MAIN_ACCOUNT, aliases: [], is_default: true, archived: false, sort: 0 }))
      for (const o of opening) {
        if (o.amount === 0) continue
        const tx = buildFrom(rates, {
          kind: 'adjustment',
          amount: o.amount,
          currency: o.currency,
          account_id: account.id,
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
    })
    deps.onChange()
  }

  return {
    addOpening,
    put,
    remove,
    removeCategory,
    removeEmptyAccount,
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

