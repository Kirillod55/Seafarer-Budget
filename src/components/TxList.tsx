import type { Category, Transaction } from '@shared/types.ts'
import { money } from '@shared/format.ts'

const SHOWN = 30

function sortRecent(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  )
}

function signedAmount(t: Transaction): { text: string; cls: string } {
  switch (t.kind) {
    case 'expense':
      return { text: money(-t.amount, t.currency), cls: 'neg' }
    case 'income':
      return { text: `+${money(t.amount, t.currency)}`, cls: 'pos' }
    case 'adjustment':
      return t.amount < 0
        ? { text: money(t.amount, t.currency), cls: 'neg' }
        : { text: `+${money(t.amount, t.currency)}`, cls: 'pos' }
    default:
      return { text: money(t.amount, t.currency), cls: '' }
  }
}

function title(t: Transaction, category: Category | undefined): string {
  if (t.note) return t.note
  if (category) return category.name
  switch (t.kind) {
    case 'transfer':
      return 'Перевод'
    case 'exchange':
      return 'Обмен'
    case 'adjustment':
      return 'Корректировка'
    default:
      return 'Без названия'
  }
}

export function TxList({
  txs,
  categories,
  onSelect,
}: {
  txs: Transaction[]
  categories: Category[]
  /** When given, rows are tappable and report the transaction id. */
  onSelect?(id: string): void
}) {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const rows = sortRecent(txs.filter((t) => !t.deleted)).slice(0, SHOWN)

  if (rows.length === 0) return <p className="muted empty">Записей пока нет</p>

  return (
    <ul className="tx-list">
      {rows.map((t) => {
        const category = t.category_id ? byId.get(t.category_id) : undefined
        const amount = signedAmount(t)
        const content = (
          <>
            <span className="tx-icon" aria-hidden="true">
              {category?.icon ?? '•'}
            </span>
            <span className="tx-main">
              <span className="tx-title">{title(t, category)}</span>
              <span className="tx-sub muted">
                {category?.name ?? 'Без категории'} · {t.date.slice(8)}.{t.date.slice(5, 7)}
                {t.rate_pending ? ' · курс уточняется' : ''}
              </span>
            </span>
            <span className={`tx-amount ${amount.cls}`}>{amount.text}</span>
          </>
        )
        return (
          <li key={t.id} className="tx">
            {onSelect ? (
              <button type="button" className="tx-btn" onClick={() => onSelect(t.id)}>
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        )
      })}
    </ul>
  )
}
