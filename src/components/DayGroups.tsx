import { useEffect, useRef } from 'react'
import { alive } from '@shared/alive.ts'
import { money } from '@shared/format.ts'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { MONTHS_GEN } from '../ui/dates.ts'
import { TxRow } from './TxRow.tsx'

/** «Сегодня», «21 октября»; another year gets its number: «30 декабря 2025». */
export function dayTitle(date: string, today: string): string {
  if (date === today) return 'Сегодня'
  const [y, m, d] = date.split('-').map(Number)
  const year = y === Number(today.slice(0, 4)) ? '' : ` ${y}`
  return `${d} ${MONTHS_GEN[m - 1]}${year}`
}

/** how long a newly appeared row counts as new (its slide-in is 0.6 s) */
const FRESH_MS = 700

/*
 * Records grouped by day in cards (spec §6 «Траты сгруппированы по дням», prototype home()/group()): a «Сегодня» /
 * «21 октября» heading aligned with the row text, a card of TxRows, newest day and newest record first, dividers
 * that start at the text, not at the edge. Lists show only alive, non-archived records. A record that appears
 * after the first render (a new one, or one brought back by «Отменить») slides in with a spring.
 */
export function DayGroups({
  txs,
  categories,
  accounts,
  partnerName,
  onOpen,
  today,
  maxDays,
  totals = false,
}: {
  txs: Transaction[]
  categories: Category[]
  accounts: Account[]
  /** settings.partner_name; empty or null → «Она» */
  partnerName: string | null
  onOpen(id: string): void
  /** the user's local date (settings time zone): «Сегодня» */
  today: string
  /** show only the newest N days (the home screen shows 3) */
  maxDays?: number
  /** the day's spending (USD) right of each heading — the «Расходы» list */
  totals?: boolean
}) {
  const visible = txs.filter((t) => alive(t) && !t.archived)
  const byDay = new Map<string, Transaction[]>()
  for (const t of visible) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t])
  const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, maxDays ?? Infinity)

  // when each shown record first appeared (0 = was there on the first render): new ones slide in
  const born = useRef(new Map<string, number>())
  const mounted = useRef(false)
  const at = performance.now()
  const shownIds = days.flatMap((d) => byDay.get(d)!.map((t) => t.id))
  for (const id of shownIds) if (!born.current.has(id)) born.current.set(id, mounted.current ? at : 0)
  useEffect(() => {
    mounted.current = true
    // forget rows that left the list, so one brought back by «Отменить» slides in again
    const keep = new Set(shownIds)
    for (const id of born.current.keys()) if (!keep.has(id)) born.current.delete(id)
  })

  if (days.length === 0) return <p className="muted empty">Записей пока нет</p>

  const catById = new Map(categories.map((c) => [c.id, c]))
  const accById = new Map(accounts.map((a) => [a.id, a]))

  return (
    <div className="days">
      {days.map((day) => {
        const rows = byDay.get(day)!.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        const spent = rows.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount_usd, 0)
        return (
          <section key={day} className="daygroup" data-flip-key={`day-${day}`}>
            <h3 className={`section${totals ? ' dsec' : ''}`}>
              <span>{dayTitle(day, today)}</span>
              {totals && <span className="num">{money(spent, 'USD')}</span>}
            </h3>
            <div className="group">
              {rows.map((t) => {
                const b = born.current.get(t.id) ?? 0
                return (
                  <TxRow
                    key={t.id}
                    tx={t}
                    category={t.category_id ? catById.get(t.category_id) : undefined}
                    account={accById.get(t.account_id)}
                    toAccount={t.to_account_id ? accById.get(t.to_account_id) : undefined}
                    partnerName={partnerName}
                    onOpen={onOpen}
                    className={b > 0 && at - b < FRESH_MS ? 'row-in' : undefined}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
