import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { monthReport } from '@shared/calc.ts'
import { localDate, monthOf, prevMonth } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { SpendPie, type PieSlice } from '../components/SpendPie.tsx'
import { useApp } from '../context.tsx'

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]
// «в сентябре» — prepositional case
const MONTHS_IN = [
  'январе',
  'феврале',
  'марте',
  'апреле',
  'мае',
  'июне',
  'июле',
  'августе',
  'сентябре',
  'октябре',
  'ноябре',
  'декабре',
]
const PALETTE = ['#4c8dff', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#84cc16']

const monthIndex = (month: string) => Number(month.slice(5, 7)) - 1
const monthTitle = (month: string) => `${MONTHS[monthIndex(month)]} ${month.slice(0, 4)}`

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
}

function comparison(total: number, prev: number, prevMonthKey: string): string {
  const inPrev = MONTHS_IN[monthIndex(prevMonthKey)]
  if (prev === 0) return `В ${inPrev} трат не было`
  const pct = Math.round((Math.abs(total - prev) / prev) * 100)
  if (pct === 0) return `Столько же, сколько в ${inPrev}`
  return `на ${pct}% ${total > prev ? 'больше' : 'меньше'}, чем в ${inPrev}`
}

const shortDate = (date: string) => `${date.slice(8)}.${date.slice(5, 7)}`

export function Report() {
  const { db, now } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, txs, categories] = await Promise.all([
      db.settings.filter((s) => !s.deleted).first(),
      db.transactions.filter((t) => !t.deleted).toArray(),
      db.categories.toArray(),
    ])
    return { settings, txs, categories }
  }, [db])
  const [chosen, setChosen] = useState<string | null>(null)

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, txs, categories } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>

  const current = monthOf(localDate(now(), settings.timezone))
  const month = chosen ?? current
  const prev = prevMonth(month)
  const report = monthReport(txs, month)
  const byId = new Map(categories.map((c) => [c.id, c]))
  const rows = report.byCategory.map((c, i) => {
    const cat = byId.get(c.categoryId)
    return {
      ...c,
      name: cat?.name ?? 'Без категории',
      icon: cat?.icon ?? '•',
      color: PALETTE[i % PALETTE.length],
    }
  })
  const slices: PieSlice[] = rows.map((r) => ({ name: r.name, value: r.usd, color: r.color }))

  return (
    <div className="stack">
      <div className="month-nav">
        <button type="button" className="btn" aria-label="Предыдущий месяц" onClick={() => setChosen(prev)}>
          ‹
        </button>
        <h2 className="month-title">{monthTitle(month)}</h2>
        <button
          type="button"
          className="btn"
          aria-label="Следующий месяц"
          disabled={month >= current}
          onClick={() => setChosen(nextMonth(month))}
        >
          ›
        </button>
      </div>

      <section className="card">
        <p className="label">Расходы за месяц</p>
        <p className="big">{money(report.totalUsd, 'USD')}</p>
        <p className="muted">{comparison(report.totalUsd, report.prevTotalUsd, prev)}</p>
      </section>

      {rows.length === 0 ? (
        <p className="muted empty">Трат в этом месяце нет</p>
      ) : (
        <>
          <section className="card stack">
            <SpendPie data={slices} />
            <ul className="cat-list" aria-label="Категории">
              {rows.map((r) => (
                <li key={r.categoryId} className="cat-row">
                  <span className="cat-dot" style={{ background: r.color }} aria-hidden="true" />
                  <span className="tx-icon" aria-hidden="true">
                    {r.icon}
                  </span>
                  <span className="cat-name">{r.name}</span>
                  <span className="cat-usd">{money(r.usd, 'USD')}</span>
                  <span className="cat-share muted">{`${Math.round(r.share * 100)}%`}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Самые крупные траты</h2>
            <ul className="tx-list" aria-label="Топ расходов">
              {report.top.map((t) => {
                const cat = t.category_id ? byId.get(t.category_id) : undefined
                return (
                  <li key={t.id} className="tx">
                    <span className="tx-icon" aria-hidden="true">
                      {cat?.icon ?? '•'}
                    </span>
                    <span className="tx-main">
                      <span className="tx-title">{cat?.name ?? 'Без категории'}</span>
                      <span className="tx-sub muted">{`${shortDate(t.date)}${t.note ? ` · ${t.note}` : ''}`}</span>
                    </span>
                    <span className="tx-amounts">
                      <span className="tx-amount">{money(t.amount, t.currency)}</span>
                      {t.currency !== 'USD' && <span className="tx-sub muted">{money(t.amount_usd, 'USD')}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
