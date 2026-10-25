import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { balanceUsd, balances } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import type { Account, Author, Category, FxRate, Settings, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { curLabel, curName } from '../ui/currencies.ts'
import { Picker } from '../ui/Picker.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Sheet, type SheetHandle } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'
import './record.css'

const FAILED = 'Не получилось — попробуй ещё раз'

type Kind = 'expense' | 'income'

/* ---------- one sheet for the whole app ---------- */

export interface RecordSheetApi {
  /** Opens the record sheet: empty for a new record, or the record `id` for editing. Ignored while one is open. */
  openRecord(id?: string): void
  /** Closes it (as «Отмена»): e.g. on navigation. */
  closeRecord(): void
}

const RecordSheetContext = createContext<RecordSheetApi>({
  openRecord() {
    if (import.meta.env.DEV) console.warn('useRecordSheet: no <RecordSheetHost/> mounted')
  },
  closeRecord() {},
})

/** `openRecord(id?)` from any screen (Home, calendar, «Расходы», the report) — the same sheet everywhere. */
export function useRecordSheet(): RecordSheetApi {
  return useContext(RecordSheetContext)
}

/** Mounted once (in Shell) around the navigator: holds the record sheet that `useRecordSheet()` opens. */
export function RecordSheetHost({ children }: { children: ReactNode }) {
  const [rec, setRec] = useState<{ key: number; id?: string; open: boolean } | null>(null)
  const seq = useRef(0)
  const api = useMemo<RecordSheetApi>(
    () => ({
      openRecord(id) {
        const key = ++seq.current
        setRec((r) => (r?.open ? r : { key, id, open: true }))
      },
      closeRecord() {
        setRec((r) => (r?.open ? { ...r, open: false } : r))
      },
    }),
    [],
  )
  return (
    <RecordSheetContext.Provider value={api}>
      {children}
      {rec && (
        <RecordSheet
          key={rec.key}
          id={rec.id}
          open={rec.open}
          onClose={() => setRec((r) => (r?.key === rec.key ? null : r))}
        />
      )}
    </RecordSheetContext.Provider>
  )
}

/* ---------- the sheet ---------- */

/**
 * «Новая запись» / «Запись» in a bottom sheet (spec §6, §9 «Окно записи: Чья трата», §4 «Архив отдельных трат»;
 * prototype recordSheet()). `onClose` is called once it has gone — unmount it then.
 */
export function RecordSheet({ id, open = true, onClose }: { id?: string; open?: boolean; onClose(): void }) {
  const { db, now } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, categories, accounts, tx, txs, rates] = await Promise.all([
      db.settings.filter(alive).first(),
      db.categories.toArray(), // all of them: a record may point at one in the bin
      db.accounts.filter(alive).sortBy('sort'),
      id ? db.transactions.get(id) : Promise.resolve(undefined),
      db.transactions.filter(alive).toArray(), // for the account balances in the «Счёт» menu
      db.fx_rates.toArray(),
    ])
    return { settings, categories, accounts, tx: tx && alive(tx) ? tx : null, txs, rates }
  }, [db, id])

  // the record as it was when the sheet opened: deleting it from the sheet must not swap the closing sheet's content
  const first = useRef<{ tx: Transaction | null } | null>(null)
  if (data && !first.current) first.current = { tx: data.tx }

  // closed before it ever loaded: nothing to slide away
  useEffect(() => {
    if (!data && !open) onClose()
  }, [data, open, onClose])

  if (!data || !first.current) return null
  const { settings, categories, accounts, txs, rates } = data
  const tx = first.current.tx
  if (!settings || (id && !tx)) {
    return (
      <Sheet open={open} onClose={onClose} title={id ? 'Запись' : 'Новая запись'}>
        <p className="muted">{settings ? 'Запись не найдена' : 'Сначала завершите настройку'}</p>
      </Sheet>
    )
  }
  return (
    <RecordForm
      existing={tx}
      settings={settings}
      categories={categories}
      accounts={accounts}
      txs={txs}
      rates={rates}
      today={localDate(now(), settings.timezone)}
      open={open}
      onClose={onClose}
    />
  )
}

function RecordForm({
  existing,
  settings,
  categories,
  accounts,
  txs,
  rates,
  today,
  open,
  onClose,
}: {
  existing: Transaction | null
  settings: Settings
  /** every category, the deleted ones too (for the record's own) */
  categories: Category[]
  accounts: Account[]
  /** alive records and the rates: each account's balance «≈ $1,475» in the «Счёт» menu */
  txs: Transaction[]
  rates: FxRate[]
  today: string
  open: boolean
  onClose(): void
}) {
  const { repo } = useApp()
  const toast = useToast()
  const sheet = useRef<SheetHandle>(null)
  const catLabel = useId()
  const multi = settings.accounts_mode === 'multi'
  const isEdit = existing !== null
  // Editing rules by kind (ruling R22):
  //   expense / income  - everything editable, the kind switch toggles between the two;
  //   adjustment        - signed non-zero amount, date, note; currency and account are locked;
  //   transfer/exchange - only date and note; every money field is shown read-only.
  const plain = !existing || existing.kind === 'expense' || existing.kind === 'income'
  const adjustment = existing?.kind === 'adjustment'
  const fixed = !plain && !adjustment
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? ''
  const partner = (settings.partner_name ?? '').trim() || 'Она'

  const [kind, setKind] = useState<Kind>(existing?.kind === 'income' ? 'income' : 'expense')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [currency, setCurrency] = useState(existing?.currency ?? settings.default_currency)
  // the record's own category stays even when it is archived or in the bin — saving must not drop it to null
  const [categoryId, setCategoryId] = useState(existing?.category_id ?? '')
  const [date, setDate] = useState(existing?.date ?? today)
  const [accountId, setAccountId] = useState(
    existing?.account_id ?? (accounts.find((a) => a.is_default && !a.archived) ?? accounts.find((a) => !a.archived) ?? accounts[0])?.id ?? '',
  )
  const [author, setAuthor] = useState<Author>(existing?.author ?? 'owner')
  const [note, setNote] = useState(existing?.note ?? '')
  const [errors, setErrors] = useState<{ amount?: string; date?: string; save?: string }>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

  const byId = new Map(categories.map((c) => [c.id, c]))
  // alive, not archived, of the chosen kind — plus the record's own one when it is archived or in the bin: a muted
  // pill, so the saved category is visible (and kept); it stays there after a tap clears it, to be chosen again
  const offered = categories.filter((c) => alive(c) && !c.archived && c.kind === kind).sort((a, b) => a.sort - b.sort)
  const own = existing?.category_id ? byId.get(existing.category_id) : undefined
  const ownGone = !!own && own.kind === kind && !own.deleted && !offered.includes(own)
  if (ownGone) offered.push(own)

  const currencies = settings.currencies.includes(currency) ? settings.currencies : [...settings.currencies, currency]
  const accountOptions = accounts.filter((a) => !a.archived || a.id === accountId)
  const accountSub = (id: string) => `≈ ${money(balanceUsd(balances(txs, id), rates, today), 'USD', { whole: true })}`

  function chooseKind(next: Kind) {
    setKind(next)
    if (categoryId && byId.get(categoryId)?.kind !== next) setCategoryId('')
  }

  function addCurrency(code: string) {
    if (settings.currencies.includes(code)) return
    void repo.put<Settings>('settings', { id: settings.id, currencies: [...settings.currencies, code] }).catch(() => toast(FAILED))
  }

  /** «Добавить» / «Готово»: false keeps the sheet open (a field did not pass, or the write failed). */
  async function save(): Promise<boolean> {
    const value = parseAmount(amount)
    const next: typeof errors = {}
    if (!fixed && (adjustment ? !(Number.isFinite(value) && value !== 0) : !(value > 0))) next.amount = 'Введите сумму'
    if (!date) next.date = 'Укажите дату'
    setErrors(next)
    if (next.amount || next.date) return false
    try {
      if (existing) {
        const patch = fixed
          ? { date, note: note.trim() }
          : adjustment
            ? { amount: value, date, note: note.trim() }
            : {
                amount: value,
                currency,
                date,
                note: note.trim(),
                account_id: accountId,
                kind,
                category_id: categoryId || null,
                author,
              }
        await repo.updateTransaction(existing.id, patch)
      } else {
        await repo.addTransaction({
          amount: value,
          currency,
          date,
          note: note.trim(),
          account_id: accountId,
          kind,
          category_id: categoryId || null,
          to_account_id: null,
          to_amount: null,
          to_currency: null,
          source: 'app',
          author,
          archived: false,
        })
      }
      return true
    } catch {
      setErrors({ save: 'Не удалось сохранить' })
      return false
    }
  }

  function remove() {
    if (!existing || !sheet.current?.close()) return
    void (async () => {
      try {
        const batch = await repo.remove('transactions', existing.id)
        if (batch) toast('Запись удалена', { label: 'Отменить', run: () => repo.restore(batch) })
      } catch {
        toast(FAILED)
      }
    })()
  }

  function archive() {
    if (!existing || !sheet.current?.close()) return
    const to = !existing.archived
    void (async () => {
      try {
        await repo.setArchived(existing.id, to)
        toast(to ? 'Запись в архиве' : 'Запись возвращена из архива', { label: 'Отменить', run: () => repo.setArchived(existing.id, !to) })
      } catch {
        toast(FAILED)
      }
    })()
  }

  const enterSaves = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sheet.current?.submit()
    }
  }

  return (
    <Sheet
      ref={sheet}
      open={open}
      onClose={onClose}
      title={isEdit ? 'Запись' : 'Новая запись'}
      trailing={{ label: isEdit ? 'Готово' : 'Добавить', run: save }}
    >
      <div className="rec">
        {plain && (
          <Segmented
            label="Тип записи"
            value={kind}
            onChange={chooseKind}
            options={[
              { value: 'expense', label: 'Расход' },
              { value: 'income', label: 'Доход' },
            ]}
          />
        )}

        <div className="grid2">
          <div className="fld">
            <label htmlFor="rec-amount">Сумма</label>
            <input
              id="rec-amount"
              className="inp num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              readOnly={fixed}
              aria-invalid={!!errors.amount}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={enterSaves}
            />
          </div>
          <div className="fld">
            <label htmlFor="rec-currency">Валюта</label>
            {plain ? (
              <Picker
                id="rec-currency"
                label="Валюта"
                kind="currency"
                allowOther
                value={currency}
                options={currencies.map((c) => ({ value: c, label: curLabel(c), sub: curName(c) }))}
                onChange={setCurrency}
                onAdd={addCurrency}
              />
            ) : (
              <input id="rec-currency" className="inp" type="text" readOnly value={currency} />
            )}
          </div>
        </div>

        {existing && fixed && existing.to_amount !== null && (
          <div className="grid2">
            <div className="fld">
              <label htmlFor="rec-to-amount">Получено</label>
              <input id="rec-to-amount" className="inp num" type="text" readOnly value={String(existing.to_amount)} />
            </div>
            <div className="fld">
              <label htmlFor="rec-to-currency">Валюта получения</label>
              <input id="rec-to-currency" className="inp" type="text" readOnly value={existing.to_currency ?? ''} />
            </div>
          </div>
        )}

        {plain && (
          <div className="fld">
            <span className="flabel" id={catLabel}>
              Категория
            </span>
            {/* a new kind mounts a new list: the pills come in as a wave; a choice only repaints them */}
            <div key={kind} className="chips stagger" role="group" aria-labelledby={catLabel}>
              {offered.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chip${ownGone && c === own ? ' gone' : ''}`}
                  style={{ '--i': i } as CSSProperties}
                  aria-pressed={c.id === categoryId}
                  onClick={() => setCategoryId((cur) => (cur === c.id ? '' : c.id))}
                >
                  <CategoryIcon category={c} size="sm" />
                  <span className="chip-t">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid2">
          <div className="fld">
            <label htmlFor="rec-date">Дата</label>
            <input
              id="rec-date"
              className="inp"
              type="date"
              aria-invalid={!!errors.date}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          {multi || fixed ? (
            <div className="fld">
              <label htmlFor="rec-account">Счёт</label>
              {plain ? (
                <Picker
                  id="rec-account"
                  label="Счёт"
                  value={accountId}
                  options={accountOptions.map((a) => ({ value: a.id, label: a.name, sub: accountSub(a.id) }))}
                  onChange={setAccountId}
                />
              ) : (
                <input id="rec-account" className="inp" type="text" readOnly value={accountName(accountId)} />
              )}
            </div>
          ) : (
            <div />
          )}
        </div>

        {existing && fixed && existing.to_account_id && (
          <div className="fld">
            <label htmlFor="rec-to-account">Счёт зачисления</label>
            <input id="rec-to-account" className="inp" type="text" readOnly value={accountName(existing.to_account_id)} />
          </div>
        )}

        {plain && (
          <div className="fld">
            <span className="flabel" aria-hidden="true">
              Чья трата
            </span>
            <Segmented<Author>
              label="Чья трата"
              value={author}
              onChange={setAuthor}
              options={[
                { value: 'owner', label: 'Моя' },
                { value: 'partner', label: partner },
              ]}
            />
          </div>
        )}

        <div className="fld">
          <label htmlFor="rec-note">Заметка</label>
          <input
            id="rec-note"
            className="inp"
            type="text"
            autoComplete="off"
            placeholder="например, молоко и хлеб"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={enterSaves}
          />
        </div>

        {(errors.amount || errors.date || errors.save) && (
          <p className="rec-err" role="alert">
            {errors.amount ?? errors.date ?? errors.save}
          </p>
        )}

        {existing &&
          (confirmDelete ? (
            <div className="rec-confirm">
              <span>Удалить эту запись?</span>
              <span className="rec-confirm-btns">
                <button type="button" className="btn-gray danger" onClick={remove}>
                  Удалить
                </button>
                <button type="button" className="btn-gray" onClick={() => setConfirmDelete(false)}>
                  Нет
                </button>
              </span>
            </div>
          ) : (
            <div className="rec-acts">
              <button type="button" className="btn-gray" onClick={archive}>
                {existing.archived ? 'Вернуть из архива' : 'В архив'}
              </button>
              <button type="button" className="btn-gray danger" onClick={() => setConfirmDelete(true)}>
                Удалить запись
              </button>
            </div>
          ))}
      </div>
    </Sheet>
  )
}
