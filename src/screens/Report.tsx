import { useId, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { UNCATEGORIZED, monthReport } from '@shared/calc.ts'
import { categoryStyle } from '@shared/defaults.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import { Donut, type DonutPart } from '../components/Donut.tsx'
import { TxRow, capitalize } from '../components/TxRow.tsx'
import { useApp } from '../context.tsx'
import { byWho, categoryOf, partnerLabel, whoOptions } from '../lib/records.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { useNav, type Who } from '../nav/Navigator.tsx'
import { useSlideIn } from '../ui/motion.ts'
import { MONTHS_IN, MONTHS_NOM, monthTitle, plural, shiftMonth } from '../ui/dates.ts'
import { ChevronLeft, ChevronRight } from '../ui/icons.ts'
import { Segmented } from '../ui/Segmented.tsx'
import { useDayTick } from '../ui/useDayTick.ts'
import { useRecordSheet } from './RecordSheet.tsx'
import './report.css'

/** The pill under the month total: «↓ на 17% меньше, чем в сентябре». */
function comparison(total: number, prev: number, prevMonthKey: string): { text: string; cls: string } {
  const inPrev = MONTHS_IN[Number(prevMonthKey.slice(5, 7)) - 1]
  if (prev === 0) return { text: `В ${inPrev} трат не было`, cls: '' }
  const d = Math.round(((total - prev) / prev) * 100)
  if (d === 0) return { text: `Как в ${inPrev}`, cls: '' }
  return d > 0
    ? { text: `↑ на ${d}% больше, чем в ${inPrev}`, cls: ' over' }
    : { text: `↓ на ${-d}% меньше, чем в ${inPrev}`, cls: ' ok' }
}

const Go = () => (
  <span className="go" aria-hidden="true">
    <ChevronRight strokeWidth={2.2} />
  </span>
)

/*
 * «Отчёт» (spec §6 «Отчёт — переделан», §9 «Отчёт»; prototype report()): ‹ Сентябрь / Ноябрь › page the month
 * (the content slides that way); the «Расходы по категориям» card — the ring, «Все / Я / Маша» under it, category
 * rows (dot, name, sum, %, a bar of the share; in «Все» also «Я $141 · Маша $54»); a sector or a row opens
 * «Расходы» of that category. Tiles 2 × 2 (the ones with «›» are buttons): the month total with the comparison
 * (opens «Расходы»), the daily average, the largest expense (opens it in the record sheet), «Я / Маша» — or
 * «Записей» for one person. Then «Самые крупные траты» as rows. Archived records count everywhere in the sums but
 * are not listed.
 */
export function Report() {
  const { db, now } = useApp()
  const nav = useNav()
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

  // null = follow the current month
  const [chosen, setChosen] = useState<string | null>(null)
  const [who, setWho] = useState<Who>('all')
  const [active, setActive] = useState<number | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const topId = useId()

  const today = localDate(now(), data?.settings?.timezone ?? 'UTC')
  const current = monthOf(today)
  const month = chosen ?? current

  // ‹ ›: the cards slide in from the side the month was paged to
  const slideFrom = useSlideIn(gridRef, month)

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, txs, categories, accounts } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>

  const page = (k: number) => {
    slideFrom(k)
    setActive(null)
    setChosen(shiftMonth(month, k))
  }
  const pickWho = (w: Who) => {
    setActive(null)
    setWho(w)
  }
  const openRecords = (category: string | null) =>
    nav.push({ tab: nav.route.tab, screen: 'records', month, category, from: 'report', who })

  const partner = partnerLabel(settings.partner_name)
  const [y, m] = month.split('-').map(Number)
  const prev = shiftMonth(month, -1)
  const report = monthReport(byWho(txs, who), month)
  const total = report.totalUsd
  const cmp = comparison(total, report.prevTotalUsd, prev)

  // her share of each category and of the month (for «Все»)
  const her = monthReport(byWho(txs, 'partner'), month)
  const herBy = new Map(her.byCategory.map((c) => [c.categoryId, c.usd]))
  const herTotal = her.totalUsd
  const meTotal = round2(total - herTotal)

  const byId = new Map(categories.map((c) => [c.id, c]))
  const rows = report.byCategory.map((c) => {
    const category = categoryOf(c.categoryId, byId)
    return { ...c, category, color: categoryStyle(category).color }
  })
  const parts: DonutPart[] = rows.map((r) => ({ key: r.categoryId, label: r.category.name, value: r.usd, color: r.color }))
  const pick = (i: number) => openRecords(rows[i]?.categoryId ?? null)

  const monthTxs = byWho(txs, who).filter((t) => t.kind === 'expense' && monthOf(t.date) === month)
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const daysGone = month === current ? Number(today.slice(8)) : month < current ? daysIn : 0
  const largest = report.top[0]
  const largestCat = largest ? categoryOf(largest.category_id ?? UNCATEGORIZED, byId) : null
  const topListed = monthTxs
    .filter((t) => !t.archived)
    .sort((a, b) => b.amount_usd - a.amount_usd)
    .slice(0, 5)
  const accById = new Map(accounts.map((a) => [a.id, a]))
  const totalLabel = who === 'all' ? 'Расходы за месяц' : who === 'me' ? 'Мои расходы' : `Расходы: ${partner}`

  const seg = <Segmented label="Чьи траты" options={whoOptions(partner)} value={who} onChange={pickWho} />

  return (
    <div className="report">
      <NavBar
        title={monthTitle(month)}
        leading={
          <button type="button" className="navback" aria-label={MONTHS_NOM[(m + 10) % 12]} onClick={() => page(-1)}>
            <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
            {MONTHS_NOM[(m + 10) % 12]}
          </button>
        }
        trailing={
          <button type="button" className="navbtn navfwd" aria-label={MONTHS_NOM[m % 12]} onClick={() => page(1)}>
            {MONTHS_NOM[m % 12]}
            <ChevronRight aria-hidden="true" strokeWidth={2.4} />
          </button>
        }
      />

      <div ref={gridRef} className="rgrid">
        <section className="card rchart" aria-label="Расходы по категориям">
          <span className="kick">Расходы по категориям</span>
          {total > 0 ? (
            <div className="donut" onMouseLeave={() => setActive(null)}>
              <div className="dleft">
                <Donut key={`${month}-${who}`} parts={parts} total={total} active={active} onActive={setActive} onPick={pick} />
                {seg}
              </div>
              <ul className="legend2" aria-label="Категории">
                {rows.map((r, i) => {
                  const pct = Math.round(r.share * 100)
                  const hers = herBy.get(r.categoryId) ?? 0
                  return (
                    <li key={r.categoryId}>
                      <button
                        type="button"
                        className={`lrow${i === active ? ' on' : ''}`}
                        style={{ '--c': r.color } as CSSProperties}
                        aria-label={`${r.category.name}: открыть траты`}
                        onMouseEnter={() => setActive(i)}
                        onFocus={() => setActive(i)}
                        onBlur={() => setActive(null)}
                        onClick={() => pick(i)}
                      >
                        <span className="ldot" />
                        <span className="lname">{r.category.name}</span>
                        <span className="lval num">
                          <span className="lsum">{money(r.usd, 'USD', { whole: true })}</span>
                          <span className="label">{`${pct}%`}</span>
                        </span>
                        <span className="lbar">
                          <i style={{ width: `${r.share * 100}%` }} />
                        </span>
                        {who === 'all' && hers > 0 && (
                          <span className="lsplit label num">
                            {`Я ${money(r.usd - hers, 'USD', { whole: true })} · `}
                            <span className="whon">{`${partner} ${money(hers, 'USD', { whole: true })}`}</span>
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : (
            <>
              <div className="dleft">{seg}</div>
              <p className="muted rempty">Трат в этом месяце нет</p>
            </>
          )}
        </section>

        <div className="rstats">
          <button type="button" className="rtile rlink" aria-label={`${totalLabel}: все записи месяца`} onClick={() => openRecords(null)}>
            <Go />
            <span className="kick">{totalLabel}</span>
            <b className="num">{money(total, 'USD')}</b>
            <span className={`pill${cmp.cls}`}>{cmp.text}</span>
          </button>
          <div className="rtile">
            <span className="kick">В среднем за день</span>
            <b className="num">{daysGone ? money(total / daysGone, 'USD') : '—'}</b>
            <span className="label">{daysGone ? `за ${plural(daysGone, 'день', 'дня', 'дней')}` : 'Месяц ещё не начался'}</span>
          </div>
          {largest && largestCat ? (
            <button type="button" className="rtile rlink" aria-label="Открыть самую крупную трату" onClick={() => openRecord(largest.id)}>
              <Go />
              <span className="kick">Самая крупная трата</span>
              <b className="num">{money(largest.amount_usd, 'USD')}</b>
              <span className="label">{largestCat.name + (largest.note.trim() ? ` · ${capitalize(largest.note.trim())}` : '')}</span>
            </button>
          ) : (
            <div className="rtile">
              <span className="kick">Самая крупная трата</span>
              <b className="num">—</b>
              <span className="label">Трат нет</span>
            </div>
          )}
          {who === 'all' ? (
            <div className="rtile">
              <span className="kick">{`Я / ${partner}`}</span>
              <b className="num">{total ? `${Math.round((meTotal / total) * 100)}% / ${Math.round((herTotal / total) * 100)}%` : '0% / 0%'}</b>
              {total > 0 && (
                <span className="split" aria-hidden="true">
                  <i className="me" style={{ width: `${(meTotal / total) * 100}%` }} />
                  <i className="her" style={{ width: `${(herTotal / total) * 100}%` }} />
                </span>
              )}
              <span className="label num">{`Я ${money(meTotal, 'USD', { whole: true })} · ${partner} ${money(herTotal, 'USD', { whole: true })}`}</span>
            </div>
          ) : (
            <button type="button" className="rtile rlink" aria-label="Все записи расходов за месяц" onClick={() => openRecords(null)}>
              <Go />
              <span className="kick">Записей</span>
              <b className="num">{monthTxs.length}</b>
              <span className="label">{`в ${plural(rows.length, 'категории', 'категориях', 'категориях')}`}</span>
            </button>
          )}
        </div>
      </div>

      {topListed.length > 0 && (
        <section className="rtop" aria-labelledby={topId}>
          <h2 id={topId} className="section">
            Самые крупные траты
          </h2>
          <div className="group">
            {topListed.map((t) => (
              <TxRow
                key={t.id}
                tx={t}
                category={t.category_id ? byId.get(t.category_id) : undefined}
                account={accById.get(t.account_id)}
                partnerName={settings.partner_name}
                onOpen={openRecord}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
