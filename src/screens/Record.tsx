import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import type { Account, Category, Settings, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'

interface Props {
  /** Transaction to edit; omitted = a new record. */
  id?: string
  onDone(): void
}

type Kind = 'expense' | 'income'

function RecordForm({
  existing,
  settings,
  categories,
  accounts,
  today,
  onDone,
}: {
  existing: Transaction | null
  settings: Settings
  categories: Category[]
  accounts: Account[]
  today: string
  onDone(): void
}) {
  const { repo } = useApp()
  const multi = settings.accounts_mode === 'multi'
  const isEdit = existing !== null
  // Editing rules by kind (ruling R22):
  //   expense / income - everything editable, the kind switch toggles between the two;
  //   adjustment       - signed non-zero amount, date, note; currency and account are locked;
  //   transfer/exchange - only date and note; every money field is shown read-only.
  const plain = !existing || existing.kind === 'expense' || existing.kind === 'income'
  const adjustment = existing?.kind === 'adjustment'
  const fixed = !plain && !adjustment
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? ''

  const [kind, setKind] = useState<Kind>(existing?.kind === 'income' ? 'income' : 'expense')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [currency, setCurrency] = useState(existing?.currency ?? settings.default_currency)
  // a category that is gone (deleted) or does not fit the kind is not offered, so it must not be saved either
  const [categoryId, setCategoryId] = useState(() => {
    const id = existing?.category_id
    const startKind = existing?.kind === 'income' ? 'income' : 'expense'
    return id && categories.some((c) => c.id === id && c.kind === startKind) ? id : ''
  })
  const [date, setDate] = useState(existing?.date ?? today)
  const [accountId, setAccountId] = useState(
    existing?.account_id ?? (accounts.find((a) => a.is_default) ?? accounts[0])?.id ?? '',
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const [errors, setErrors] = useState<{ amount?: string; date?: string; save?: string }>({})
  const [busy, setBusy] = useState(false)
  // two-step delete in place instead of window.confirm: «Удалить» → «Точно удалить?» / «Нет»
  const [confirmDelete, setConfirmDelete] = useState(false)

  const currencies = settings.currencies.includes(currency) ? settings.currencies : [...settings.currencies, currency]
  const kindCategories = categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId))
  const accountOptions = accounts.filter((a) => !a.archived || a.id === accountId)

  function chooseKind(next: Kind) {
    setKind(next)
    if (!categories.some((c) => c.id === categoryId && c.kind === next)) setCategoryId('')
  }

  async function save() {
    const value = parseAmount(amount)
    const next: typeof errors = {}
    if (!fixed && (adjustment ? !(Number.isFinite(value) && value !== 0) : !(value > 0))) next.amount = 'Введите сумму'
    if (!date) next.date = 'Укажите дату'
    setErrors(next)
    if (next.amount || next.date) return
    setBusy(true)
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
        })
      }
      onDone()
    } catch {
      setErrors({ save: 'Не удалось сохранить' })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!existing) return
    setBusy(true)
    try {
      await repo.remove('transactions', existing.id)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>{isEdit ? 'Запись' : 'Новая запись'}</h2>

      {plain && (
        <div className="choice" role="group" aria-label="Тип записи">
          {(['expense', 'income'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`btn choice-btn${kind === k ? ' active' : ''}`}
              aria-pressed={kind === k}
              onClick={() => chooseKind(k)}
            >
              {k === 'expense' ? 'Расход' : 'Доход'}
            </button>
          ))}
        </div>
      )}

      <div className="row">
        <div className="grow">
          <label htmlFor="rec-amount">Сумма</label>
          <input
            id="rec-amount"
            className="field"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            readOnly={fixed}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="w-cur">
          <label htmlFor="rec-currency">Валюта</label>
          {plain ? (
            <select id="rec-currency" className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input id="rec-currency" className="field" type="text" readOnly value={currency} />
          )}
        </div>
      </div>
      {errors.amount && (
        <p className="error" role="alert">
          {errors.amount}
        </p>
      )}

      {existing && fixed && existing.to_amount !== null && (
        <div className="row">
          <div className="grow">
            <label htmlFor="rec-to-amount">Получено</label>
            <input id="rec-to-amount" className="field" type="text" readOnly value={String(existing.to_amount)} />
          </div>
          <div className="w-cur">
            <label htmlFor="rec-to-currency">Валюта получения</label>
            <input id="rec-to-currency" className="field" type="text" readOnly value={existing.to_currency ?? ''} />
          </div>
        </div>
      )}

      {plain && (
        <div>
          <label htmlFor="rec-category">Категория</label>
          <select id="rec-category" className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Без категории</option>
            {kindCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.icon} ${c.name}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label htmlFor="rec-date">Дата</label>
        <input id="rec-date" className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {errors.date && (
          <p className="error" role="alert">
            {errors.date}
          </p>
        )}
      </div>

      {(multi || fixed) &&
        (plain ? (
          <div>
            <label htmlFor="rec-account">Счёт</label>
            <select id="rec-account" className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label htmlFor="rec-account">Счёт</label>
            <input id="rec-account" className="field" type="text" readOnly value={accountName(accountId)} />
          </div>
        ))}

      {existing && fixed && existing.to_account_id && (
        <div>
          <label htmlFor="rec-to-account">Счёт зачисления</label>
          <input id="rec-to-account" className="field" type="text" readOnly value={accountName(existing.to_account_id)} />
        </div>
      )}

      <div>
        <label htmlFor="rec-note">Заметка</label>
        <input id="rec-note" className="field" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {errors.save && (
        <p className="error" role="alert">
          {errors.save}
        </p>
      )}

      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onDone}>
          Отмена
        </button>
      </div>
      {isEdit &&
        (confirmDelete ? (
          <div className="row">
            <button type="button" className="btn btn-danger grow" disabled={busy} onClick={() => void remove()}>
              Точно удалить?
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Нет
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Удалить
          </button>
        ))}
    </form>
  )
}

export function RecordScreen({ id, onDone }: Props) {
  const { db, now } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, categories, accounts, tx] = await Promise.all([
      db.settings.filter(alive).first(),
      db.categories.filter(alive).toArray(),
      db.accounts.filter(alive).sortBy('sort'),
      id ? db.transactions.get(id) : Promise.resolve(undefined),
    ])
    return { settings, categories, accounts, tx: tx && alive(tx) ? tx : null }
  }, [db, id])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, categories, accounts, tx } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>
  if (id && !tx) {
    return (
      <div className="stack">
        <p className="muted pad">Запись не найдена</p>
        <button type="button" className="btn btn-block" onClick={onDone}>
          Назад
        </button>
      </div>
    )
  }

  return (
    <RecordForm
      key={id ?? 'new'}
      existing={tx}
      settings={settings}
      categories={categories}
      accounts={accounts}
      today={localDate(now(), settings.timezone)}
      onDone={onDone}
    />
  )
}
