import { money } from '@shared/format.ts'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { PartnerBadge } from '../ui/PartnerBadge.tsx'
import { SwipeRow, type SwipeAction } from '../ui/SwipeRow.tsx'
import { useToast } from '../ui/Toast.tsx'

const FAILED = 'Не получилось — попробуй ещё раз'

/** A note starts with a capital letter, old records too (spec §6 «Заметка траты с большой буквы»). */
export const capitalize = (s: string): string => (s ? s.charAt(0).toLocaleUpperCase('ru') + s.slice(1) : s)

const KIND_TITLE: Record<Transaction['kind'], string> = {
  expense: 'Без категории',
  income: 'Без категории',
  transfer: 'Перевод',
  exchange: 'Обмен',
  adjustment: 'Корректировка',
}

/** The tile for a record without a category (transfer, exchange, adjustment): neutral grey wallet. */
function bareCategory(name: string): Category {
  return {
    id: '',
    deleted: false,
    name,
    kind: 'expense',
    icon: '',
    keywords: [],
    archived: false,
    sort: 0,
    color: '#8E8E93',
    glyph: 'wallet',
    deleted_at: null,
    deleted_batch: null,
  }
}

/**
 * The amount column: USD first (spec: expenses without «−», income green with «+»), the original currency below.
 * While the rate is still pending the USD figure is not known yet: the original amount comes first.
 */
function amounts(tx: Transaction): { main: string; sub: string | null; inc: boolean } {
  if (tx.kind === 'transfer' || tx.kind === 'exchange') {
    const sub = tx.kind === 'exchange' && tx.to_amount !== null && tx.to_currency ? money(tx.to_amount, tx.to_currency) : null
    return { main: money(tx.amount, tx.currency), sub, inc: false }
  }
  const inc = tx.kind === 'income' || (tx.kind === 'adjustment' && tx.amount > 0)
  // only a negative adjustment keeps its minus, written by money() itself; expenses have none, income gets «+»
  const neg = tx.kind === 'adjustment' && tx.amount < 0
  const fmt = (v: number, cur: string) => (inc ? '+' : '') + money(neg ? -Math.abs(v) : Math.abs(v), cur)
  if (tx.currency === 'USD') return { main: fmt(tx.amount, 'USD'), sub: null, inc }
  if (tx.rate_pending) return { main: fmt(tx.amount, tx.currency), sub: 'курс уточняется', inc }
  // the original amount below carries the same sign as the USD line
  return { main: fmt(tx.amount_usd, 'USD'), sub: fmt(tx.amount, tx.currency), inc }
}

/*
 * One record in a list (spec §6, §9 «Пометка в списках»; prototype txRow): the category tile — with her initial
 * on its corner when the second person wrote it — the category name, «**Маша** · Кофе» (or just the note), the
 * amount. Swipe left: «Изменить» (opens the record), «В архив» (toast «Запись в архиве · Отменить»), «Удалить»
 * (soft delete into the 24 h bin, toast «Запись удалена · Отменить» → restore).
 */
export function TxRow({
  tx,
  category,
  account,
  toAccount,
  partnerName,
  onOpen,
  className,
}: {
  tx: Transaction
  category?: Category
  /** the accounts of a transfer / exchange: «Карта → Наличные» is its subtitle when it has no note */
  account?: Account
  toAccount?: Account
  /** settings.partner_name; empty or null → «Она» */
  partnerName: string | null
  onOpen(id: string): void
  className?: string
}) {
  const { repo } = useApp()
  const toast = useToast()
  const hers = tx.author === 'partner'
  const name = (partnerName ?? '').trim() || 'Она'
  const title = category?.name ?? KIND_TITLE[tx.kind]
  const where = account && toAccount ? `${account.name} → ${toAccount.name}` : account?.name
  const moves = tx.kind === 'transfer' || tx.kind === 'exchange'
  const note = capitalize(tx.note.trim()) || (moves ? where : '') || ''
  const amount = amounts(tx)

  const archive = async () => {
    try {
      await repo.setArchived(tx.id, true)
      toast('Запись в архиве', { label: 'Отменить', run: () => repo.setArchived(tx.id, false) })
    } catch {
      toast(FAILED)
    }
  }

  const remove = async () => {
    try {
      const batch = await repo.remove('transactions', tx.id)
      if (batch) toast('Запись удалена', { label: 'Отменить', run: () => repo.restore(batch) })
    } catch {
      toast(FAILED)
    }
  }

  const actions: SwipeAction[] = [
    { key: 'edit', label: 'Изменить', run: () => onOpen(tx.id) },
    { key: 'archive', label: 'В архив', run: () => void archive() },
    { key: 'delete', label: 'Удалить', run: () => void remove() },
  ]

  return (
    <SwipeRow actions={actions} onOpen={() => onOpen(tx.id)} className={className}>
      <span className="ic-wrap" aria-hidden="true">
        <CategoryIcon category={category ?? bareCategory(title)} />
        {hers && <PartnerBadge name={name} />}
      </span>
      <span className="t">
        <span className="t1">{title}</span>
        <span className="t2">
          {hers ? (
            <>
              <b className="whon">{name}</b>
              {note && ` · ${note}`}
            </>
          ) : (
            note || '—'
          )}
        </span>
      </span>
      <span className={`a num${amount.inc ? ' inc' : ''}`}>
        {amount.main}
        {amount.sub && <small>{amount.sub}</small>}
      </span>
    </SwipeRow>
  )
}
