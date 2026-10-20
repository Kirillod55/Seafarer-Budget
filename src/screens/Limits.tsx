import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { limitStatus } from '@shared/calc.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import type { Category, Limit } from '@shared/types.ts'
import { ProgressBar } from '../components/ProgressBar.tsx'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'

const usd = (n: number) => money(n, 'USD')

/** Create (category picker) or edit (fixed category, plus «Убрать лимит») a monthly limit. */
function LimitForm({
  limit,
  choices,
  onClose,
}: {
  limit: Limit | null
  choices: Category[]
  onClose(): void
}) {
  const { db, repo } = useApp()
  const [categoryId, setCategoryId] = useState(limit?.category_id ?? choices[0]?.id ?? '')
  const [amount, setAmount] = useState(limit ? String(limit.monthly_usd) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    if (!categoryId) return setError('Выберите категорию')
    setBusy(true)
    try {
      // a category whose limit was removed earlier reuses that (soft-deleted) row instead of adding a second one
      const id = limit?.id ?? (await db.limits.filter((l) => l.category_id === categoryId).first())?.id
      await repo.put<Limit>('limits', { id, category_id: categoryId, monthly_usd: value, deleted: false })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  async function removeLimit() {
    if (!limit) return
    setBusy(true)
    try {
      await repo.remove('limits', limit.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {!limit && (
        <div>
          <label htmlFor="limit-category">Категория</label>
          <select id="limit-category" className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.icon} ${c.name}`}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="limit-amount">Лимит в месяц, $</label>
        <input
          id="limit-amount"
          className="field"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
      {limit && (
        <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={() => void removeLimit()}>
          Убрать лимит
        </button>
      )}
    </form>
  )
}

type Editing = { kind: 'new' } | { kind: 'edit'; id: string } | null

export function Limits() {
  const { db, now } = useApp()
  const [editing, setEditing] = useState<Editing>(null)
  const data = useLiveQuery(async () => {
    const [settings, categories, limits, txs] = await Promise.all([
      db.settings.filter((s) => !s.deleted).first(),
      db.categories.filter((c) => !c.deleted && !c.archived && c.kind === 'expense').sortBy('sort'),
      db.limits.filter((l) => !l.deleted).toArray(),
      db.transactions.filter((t) => !t.deleted).toArray(),
    ])
    return { settings, categories, limits, txs }
  }, [db])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, categories, limits, txs } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>
  const month = monthOf(localDate(now(), settings.timezone))

  const limitOf = new Map(limits.map((l) => [l.category_id, l]))
  const rows = categories.flatMap((c) => {
    const limit = limitOf.get(c.id)
    return limit ? [{ category: c, limit, status: limitStatus(limit, txs, month) }] : []
  })
  const free = categories.filter((c) => !limitOf.has(c.id))

  return (
    <div className="stack">
      <h2>Лимиты</h2>
      {editing?.kind === 'new' ? (
        <LimitForm limit={null} choices={free} onClose={() => setEditing(null)} />
      ) : free.length > 0 ? (
        <button type="button" className="btn btn-block" onClick={() => setEditing({ kind: 'new' })}>
          Задать лимит
        </button>
      ) : null}
      {rows.length === 0 && editing?.kind !== 'new' && <p className="muted empty">Лимитов пока нет</p>}
      <ul className="limit-list">
        {rows.map(({ category, limit, status }) => (
          <li key={limit.id} className="card">
            {editing?.kind === 'edit' && editing.id === limit.id ? (
              <LimitForm limit={limit} choices={free} onClose={() => setEditing(null)} />
            ) : (
              <button type="button" className="limit-btn stack" onClick={() => setEditing({ kind: 'edit', id: limit.id })}>
                <span className="limit-title">{`${category.icon} ${category.name}`}</span>
                <ProgressBar share={status.share} level={status.level} />
                <span className={`small${status.level === 'ok' ? ' muted' : ` limit-${status.level}`}`}>
                  {`${usd(status.spentUsd)} из ${usd(limit.monthly_usd)}`}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
