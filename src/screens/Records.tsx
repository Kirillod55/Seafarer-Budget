import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { UNCATEGORIZED } from '@shared/calc.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import { DayGroups } from '../components/DayGroups.tsx'
import { useApp } from '../context.tsx'
import { byWho, categoryOf, partnerLabel, whoOptions } from '../lib/records.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { useRoute, type Who } from '../nav/Navigator.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { useSlideIn } from '../ui/motion.ts'
import { MONTHS_IN, MONTHS_NOM, monthTitle, plural, shiftMonth } from '../ui/dates.ts'
import { ChevronLeft, ChevronRight } from '../ui/icons.ts'
import { Segmented } from '../ui/Segmented.tsx'
import { useDayTick } from '../ui/useDayTick.ts'
import { useRecordSheet } from './RecordSheet.tsx'
import './report.css'

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

  // ‹ ›: the list slides in from the side it was paged to
  const slideFrom = useSlideIn(bodyRef, month)

  if (!params) return null
  const category = params.category
  const from = params.from === 'cats' ? 'Категории' : 'Отчёт'
  const byId = new Map((data?.categories ?? []).map((c) => [c.id, c]))
  const cat = category ? categoryOf(category, byId) : null
  // an income category (from «Категории») lists its incomes; everything else lists expenses
  const kind = cat?.kind === 'income' ? 'income' : 'expense'
  const title = cat ? cat.name : 'Расходы'
  const heading = cat ? (
    <span className="rtitle">
      <CategoryIcon category={cat} />
      {cat.name}
    </span>
  ) : undefined

  const page = (k: number) => {
    slideFrom(k)
    setMonth(shiftMonth(month, k))
  }
  const [, m] = month.split('-').map(Number)

  let body = <p className="muted pad">Загрузка…</p>
  if (data) {
    const { settings, txs, categories, accounts } = data
    const today = localDate(now(), settings?.timezone ?? 'UTC')
    const all = byWho(txs, who).filter(
      (t) =>
        t.kind === kind &&
        monthOf(t.date) === month &&
        (!category || (t.category_id ?? UNCATEGORIZED) === category),
    )
    const listed = all.filter((t) => !t.archived)
    const archived = all.length - listed.length
    const total = round2(all.reduce((s, t) => s + t.amount_usd, 0))
    const line = all.length
      ? `${plural(all.length, 'запись', 'записи', 'записей')} на ${money(total, 'USD')}${archived ? ` · ${archived} из них в архиве` : ''}`
      : `${kind === 'income' ? 'Доходов' : 'Трат'}${category ? ' в этой категории' : ''} в ${MONTHS_IN[m - 1]} нет`
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
