import { useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Category, Transaction } from '@shared/types.ts'
import { DayGroups } from '../components/DayGroups.tsx'
import { bareCategory } from '../components/TxRow.tsx'
import { useApp } from '../context.tsx'
import { NavBar } from '../nav/NavBar.tsx'
import { useRoute, type Who } from '../nav/Navigator.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { prefersReducedMotion } from '../ui/motion.ts'
import { MONTHS_IN, MONTHS_NOM, monthTitle, plural, shiftMonth } from '../ui/dates.ts'
import { ChevronLeft, ChevronRight } from '../ui/icons.ts'
import { Segmented } from '../ui/Segmented.tsx'
import { useDayTick } from './Home.tsx'
import { useRecordSheet } from './RecordSheet.tsx'
import './report.css'

/** The key of expenses without a category (the report's «Без категории» row). */
export const UNCATEGORIZED = 'uncategorized'

/** The second person's name in the interface: settings.partner_name, «Она» when unset. */
export const partnerLabel = (name: string | null | undefined): string => (name ?? '').trim() || 'Она'

/** «Все / Я / Маша» */
export const whoOptions = (partner: string): { value: Who; label: string }[] => [
  { value: 'all', label: 'Все' },
  { value: 'me', label: 'Я' },
  { value: 'partner', label: partner },
]

/** The records of whoever is chosen: everyone, the owner's, or the second person's. */
export function byWho(txs: Transaction[], who: Who): Transaction[] {
  if (who === 'all') return txs
  const author = who === 'me' ? 'owner' : 'partner'
  return txs.filter((t) => t.author === author)
}

/** The category of a report row / route key, or a grey «Без категории» tile. */
export function categoryOf(key: string, byId: Map<string, Category>): Category {
  return byId.get(key) ?? bareCategory('Без категории')
}

const IOS = 'cubic-bezier(.32,.72,0,1)'

/*
 * «Расходы» (spec §6 «Отчёт — переделан», §4 «Архив отдельных трат»; prototype records()): the month's expenses
 * by day, newest first, the day's sum on the right; ‹ month ›, «Все / Я / Маша», «32 записи на $289.88 · 1 из них
 * в архиве». Archived records count in the line's sum but are not listed. With a category (from a report sector or
 * row, or from «Категории») the title is its icon and name. Back: «‹ Отчёт» or «‹ Категории».
 */
export function Records() {
  const route = useRoute()
  const params = route.screen === 'records' ? route : null
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

  const [month, setMonth] = useState(params?.month ?? monthOf(localDate(now(), 'UTC')))
  const [who, setWho] = useState<Who>(params?.who ?? 'all')
  const bodyRef = useRef<HTMLDivElement>(null)
  const slide = useRef(0)

  // ‹ ›: the list slides in from the side it was paged to
  useLayoutEffect(() => {
    const d = slide.current
    const el = bodyRef.current
    slide.current = 0
    if (!d || !el || prefersReducedMotion() || typeof el.animate !== 'function') return
    el.animate([{ opacity: 0, transform: `translateX(${d * 28}px)` }, { opacity: 1, transform: 'none' }], {
      duration: 420,
      easing: IOS,
    })
  }, [month])

  if (!params) return null
  const category = params.category
  const from = params.from === 'cats' ? 'Категории' : 'Отчёт'
  const byId = new Map((data?.categories ?? []).map((c) => [c.id, c]))
  const cat = category ? categoryOf(category, byId) : null
  const title = cat ? cat.name : 'Расходы'
  const heading = cat ? (
    <span className="rtitle">
      <CategoryIcon category={cat} />
      {cat.name}
    </span>
  ) : undefined

  const page = (k: number) => {
    slide.current = k
    setMonth(shiftMonth(month, k))
  }
  const [, m] = month.split('-').map(Number)

  let body = <p className="muted pad">Загрузка…</p>
  if (data) {
    const { settings, txs, categories, accounts } = data
    const today = localDate(now(), settings?.timezone ?? 'UTC')
    const all = byWho(txs, who).filter(
      (t) =>
        t.kind === 'expense' &&
        monthOf(t.date) === month &&
        (!category || (t.category_id ?? UNCATEGORIZED) === category),
    )
    const listed = all.filter((t) => !t.archived)
    const archived = all.length - listed.length
    const total = round2(all.reduce((s, t) => s + t.amount_usd, 0))
    const line = all.length
      ? `${plural(all.length, 'запись', 'записи', 'записей')} на ${money(total, 'USD')}${archived ? ` · ${archived} из них в архиве` : ''}`
      : `Трат${category ? ' в этой категории' : ''} в ${MONTHS_IN[m - 1]} нет`
    body = (
      <>
        <p className="label num rec-line">{line}</p>
        {listed.length > 0 && (
          <DayGroups
            txs={listed}
            categories={categories}
            accounts={accounts}
            partnerName={settings?.partner_name ?? null}
            today={today}
            totals
            onOpen={openRecord}
          />
        )}
      </>
    )
  }

  return (
    <div className="records">
      <NavBar back={{ label: from }} title={title} heading={heading} />
      <div className="mswitch">
        <button type="button" className="round-btn" aria-label={MONTHS_NOM[(m + 10) % 12]} onClick={() => page(-1)}>
          <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
        </button>
        <b className="num">{monthTitle(month)}</b>
        <button type="button" className="round-btn" aria-label={MONTHS_NOM[m % 12]} onClick={() => page(1)}>
          <ChevronRight aria-hidden="true" strokeWidth={2.4} />
        </button>
      </div>
      <Segmented<Who> label="Чьи траты" options={whoOptions(partnerLabel(data?.settings?.partner_name))} value={who} onChange={setWho} />
      <div ref={bodyRef} className="rec-body">
        {body}
      </div>
    </div>
  )
}
