import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { localDate } from '@shared/dates.ts'
import type { Account, Category, Settings, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'

interface Props {
  /** Transaction to edit; omitted = a new record. */
  id?: string
  onDone(): void
}

type Kind = 'expense' | 'income'

/** «12,5» and «12.5» both work; anything that is not a positive number gives NaN/0. */
function parseAmount(text: string): number {
  const n = Number(text.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

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
  // transfer / exchange / adjustment keep their own kind: only amount, date, note and delete make sense for them
  const plain = !existing || existing.kind === 'expense' || existing.kind === 'income'

  const [kind, setKind] = useState<Kind>(existing?.kind === 'income' ? 'income' : 'expense')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [currency, setCurrency] = useState(existing?.currency ?? settings.default_currency)
  const [categoryId, setCategoryId] = useState(existing?.category_id ?? '')
  const [date, setDate] = useState(existing?.date ?? today)
  const [accountId, setAccountId] = useState(
    existing?.account_id ?? (accounts.find((a) => a.is_default) ?? accounts[0])?.id ?? '',
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const currencies = settings.currencies.includes(currency) ? settings.currencies : [...settings.currencies, currency]
  const kindCategories = categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId))
  const accountOptions = accounts.filter((a) => !a.archived || a.id === accountId)

  function chooseKind(next: Kind) {
    setKind(next)
    if (!categories.some((c) => c.id === categoryId && c.kind === next)) setCategoryId('')
  }

  async function save() {
    const value = parseAmount(amount)
    if (!(value > 0)) {
      setError('Введите сумму')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const fields = {
        amount: value,
        currency,
        date,
        note: note.trim(),
        account_id: accountId,
        ...(plain ? { kind, category_id: categoryId || null } : {}),
      }
      if (existing) {
        await repo.updateTransaction(existing.id, fields)
      } else {
        await repo.addTransaction({
          ...fields,
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
      setError('Не удалось сохранить')
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
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="w-cur">
          <label htmlFor="rec-currency">Валюта</label>
          <select id="rec-currency" className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
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
      </div>

      {multi && (
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
      )}

      <div>
        <label htmlFor="rec-note">Заметка</label>
        <input id="rec-note" className="field" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onDone}>
          Отмена
        </button>
      </div>
      {isEdit && (
        <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={() => void remove()}>
          Удалить
        </button>
      )}
    </form>
  )
}

export function RecordScreen({ id, onDone }: Props) {
  const { db, now } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, categories, accounts, tx] = await Promise.all([
      db.settings.filter((s) => !s.deleted).first(),
      db.categories.filter((c) => !c.deleted).toArray(),
      db.accounts.filter((a) => !a.deleted).sortBy('sort'),
      id ? db.transactions.get(id) : Promise.resolve(undefined),
    ])
    return { settings, categories, accounts, tx: tx && !tx.deleted ? tx : null }
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
