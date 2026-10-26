import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { monthReport } from '@shared/calc.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { DayGroups, dayTitle } from '../components/DayGroups.tsx'
import { bareCategory } from '../components/TxRow.tsx'
import { useApp } from '../context.tsx'
import { NavBar } from '../nav/NavBar.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { Morph } from '../ui/Morph.tsx'
import { prefersReducedMotion } from '../ui/motion.ts'
import { MONTHS_NOM, dayMonth } from '../ui/dates.ts'
import { Anchor, ChevronLeft, ChevronRight } from '../ui/icons.ts'
import { useDayTick } from './Home.tsx'
import { useRecordSheet } from './RecordSheet.tsx'
import './calendar.css'

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const IOS = 'cubic-bezier(.32,.72,0,1)'

/** «1 запись», «2 записи», «5 записей» */
function records(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? 'запись' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'записи' : 'записей'
  return `${n} ${word}`
}

function shiftMonth(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7)
}

/** The month's days: blanks before the 1st (the week starts on Monday), then 'YYYY-MM-DD' for each day. */
function monthCells(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number)
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const out: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= days; d++) out.push(`${month}-${String(d).padStart(2, '0')}`)
  return out
}

/*
 * «Календарь трат» (spec §3; prototype calendar(), dayBlock(), pickDay()): the month Monday to Sunday with ‹ ›,
 * «За месяц $X», each day's spending in whole dollars; today outlined in lime, the picked day filled, the landing
 * day ⚓, future days off. Picking a day touches only the fill and the card under the grid (Morph sideways, by the
 * date's direction) — the title, the grid and the scroll stay. Archived records count in the sums (the money is
 * spent) but are not listed.
 */
export function Calendar() {
  const { db, now } = useApp()
  const { openRecord } = useRecordSheet()
  const data = useLiveQuery(async () => {
    const [settings, txs, categories, accounts] = await Promise.all([
      db.settings.filter(alive).first(),
      db.transactions.filter(alive).toArray(),
      db.categories.toArray(),
      db.accounts.toArray(),
    ])
    return { settings, txs, categories, accounts }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  // the month on screen and the picked day; null = follow today (it moves at midnight)
  const [month, setMonth] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [dir, setDir] = useState(1)
  const gridRef = useRef<HTMLDivElement>(null)
  const slide = useRef(0)
  const pickAnim = useRef<Animation | null>(null)

  const today = localDate(now(), data?.settings?.timezone ?? 'UTC')
  const shown = month ?? monthOf(today)
  const sel = picked ?? today

  // ‹ ›: the new month slides in from the side it was paged to (prototype .slide-r / .slide-l)
  useLayoutEffect(() => {
    const d = slide.current
    const el = gridRef.current
    slide.current = 0
    if (!d || !el || prefersReducedMotion() || typeof el.animate !== 'function') return
    el.animate([{ opacity: 0, transform: `translateX(${d * 28}px)` }, { opacity: 1, transform: 'none' }], {
      duration: 420,
      easing: IOS,
    })
  }, [shown])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, txs, categories, accounts } = data

  const pageMonth = (k: number) => {
    slide.current = k
    setMonth(shiftMonth(shown, k))
  }

  const pick = (day: string, e: MouseEvent<HTMLButtonElement>) => {
    const cell = e.currentTarget
    if (!prefersReducedMotion() && typeof cell.animate === 'function') {
      pickAnim.current?.cancel()
      pickAnim.current = cell.animate([{ transform: 'scale(.93)' }, { transform: 'none' }], {
        duration: 340,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      })
    }
    if (day === sel) return
    setDir(day > sel ? 1 : -1)
    setPicked(day)
  }

  // spending per day (USD): archived records included, they are money spent
  const spent = new Map<string, number>()
  for (const t of txs) if (t.kind === 'expense' && monthOf(t.date) === shown) spent.set(t.date, (spent.get(t.date) ?? 0) + t.amount_usd)
  const monthTotal = monthReport(txs, shown).totalUsd
  const landing = settings?.next_contract_date ?? null
  const [y, m] = shown.split('-').map(Number)
  const title = `${MONTHS_NOM[m - 1]} ${y}`

  return (
    <div className="calendar">
      <NavBar
        back={{ label: 'Главная' }}
        title={title}
        aside={
          <span className="cal-arrows">
            <button type="button" className="round-btn" aria-label="Предыдущий месяц" onClick={() => pageMonth(-1)}>
              <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
            </button>
            <button type="button" className="round-btn" aria-label="Следующий месяц" onClick={() => pageMonth(1)}>
              <ChevronRight aria-hidden="true" strokeWidth={2.4} />
            </button>
          </span>
        }
      />
      <p className="label num cal-total">{`За месяц ${money(monthTotal, 'USD', { whole: true })}`}</p>

      <div ref={gridRef} className="cal">
        {WEEKDAYS.map((w) => (
          <div key={w} className="wd" aria-hidden="true">
            {w}
          </div>
        ))}
        {monthCells(shown).map((day, i) => {
          if (!day) return <div key={`b${i}`} className="cal-blank" />
          const v = round2(spent.get(day) ?? 0)
          const cls = `day${day === sel ? ' sel' : ''}${day === today ? ' today' : ''}`
          return (
            <button
              key={day}
              type="button"
              className={cls}
              data-day={day}
              disabled={day > today}
              aria-pressed={day === sel}
              aria-label={`${dayMonth(day)}${v ? `, потрачено ${money(v, 'USD')}` : ''}`}
              onClick={(e) => pick(day, e)}
            >
              <span className="dn">
                {Number(day.slice(8))}
                {day === landing && <Anchor className="anchor" aria-hidden="true" strokeWidth={2.2} />}
              </span>
              <span className="dv num">{v ? money(v, 'USD', { whole: true }) : ''}</span>
            </button>
          )
        })}
      </div>

      <div className="calday" aria-live="polite">
        <Morph k={sel} dir={dir}>
          <DayCard
            day={sel}
            today={today}
            txs={txs.filter((t) => t.date === sel)}
            categories={categories}
            accounts={accounts}
            partnerName={settings?.partner_name ?? null}
            onOpen={openRecord}
          />
        </Morph>
      </div>
    </div>
  )
}

/** The picked day under the grid (prototype dayBlock): date and sum, spending by category, the records. */
function DayCard({
  day,
  today,
  txs,
  categories,
  accounts,
  partnerName,
  onOpen,
}: {
  day: string
  today: string
  /** the day's alive records, archived ones too */
  txs: Transaction[]
  categories: Category[]
  accounts: Account[]
  partnerName: string | null
  onOpen(id: string): void
}) {
  const expenses = txs.filter((t) => t.kind === 'expense')
  const total = round2(expenses.reduce((s, t) => s + t.amount_usd, 0))
  const listed = txs.filter((t) => !t.archived)
  const archived = expenses.filter((t) => t.archived).length

  const catById = new Map(categories.map((c) => [c.id, c]))
  const byCat = new Map<string, number>()
  for (const t of expenses) byCat.set(t.category_id ?? '', (byCat.get(t.category_id ?? '') ?? 0) + t.amount_usd)
  const cats = [...byCat.entries()]
    .map(([id, usd]) => ({ category: catById.get(id) ?? bareCategory('Без категории'), usd: round2(usd) }))
    .sort((a, b) => b.usd - a.usd)

  return (
    <div className="cdin">
      <div className="cd-head">
        <h3>{day === today ? `Сегодня, ${dayMonth(day)}` : dayTitle(day, today)}</h3>
        <span className="cd-sum num">{money(total, 'USD')}</span>
      </div>
      {cats.length > 0 && (
        <div className="cd-cats">
          {cats.map(({ category, usd }) => (
            <span key={category.id || category.name} className="cd-chip num">
              <CategoryIcon category={category} size="sm" />
              <span className="cd-cname">{category.name}</span>
              {money(usd, 'USD')}
            </span>
          ))}
        </div>
      )}
      {listed.length > 0 ? (
        <DayGroups
          txs={listed}
          categories={categories}
          accounts={accounts}
          partnerName={partnerName}
          today={today}
          headings={false}
          onOpen={onOpen}
        />
      ) : (
        <p className="muted cd-empty">{archived ? 'Все записи этого дня в архиве' : 'В этот день трат не было'}</p>
      )}
      {archived > 0 && <p className="label cd-note">{`${records(archived)} в архиве — в сумме дня учтены`}</p>}
    </div>
  )
}
