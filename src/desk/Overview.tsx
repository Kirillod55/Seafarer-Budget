import type { CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { goalProgress, limitStatus, monthReport } from '@shared/calc.ts'
import { categoryStyle } from '@shared/defaults.ts'
import { addDays, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Category, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { byWho, categoryOf, partnerLabel } from '../lib/records.ts'
import { useNav } from '../nav/Navigator.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { MONTHS_NOM, dayMonth } from '../ui/dates.ts'
import { routeOf } from './Sidebar.tsx'

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const whole = (n: number) => money(n, 'USD', { whole: true })

/** USD spent per day of `month` — expenses, archived ones included (as the calendar). */
export function daySpend(txs: Transaction[], month: string): Map<string, number> {
  const spent = new Map<string, number>()
  for (const t of txs) if (t.kind === 'expense' && monthOf(t.date) === month) spent.set(t.date, (spent.get(t.date) ?? 0) + t.amount_usd)
  return spent
}

/** The month as weeks from Monday: leading nulls, then every day. */
function monthDays(month: string): (string | null)[] {
  const first = `${month}-01`
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7
  const out: (string | null)[] = Array(lead).fill(null)
  for (let d = first; monthOf(d) === month; d = addDays(d, 1)) out.push(d)
  return out
}

/*
 * The «Обзор» column of the PC home (spec §11 «Главная — панель»; prototype dashAside): the month calendar lit by
 * how much was spent (brighter = more; today outlined; future days pale; a click opens the calendar on that day),
 * the month with «Я / Маша» and the top 4 categories, goals, limits. Numbers are the report's and the calendar's.
 */
export function Overview({ today }: { today: string }) {
  const { db } = useApp()
  const nav = useNav()
  const data = useLiveQuery(async () => {
    const [settings, txs, categories, goals, moves, limits] = await Promise.all([
      db.settings.filter(alive).first(),
      db.transactions.filter(alive).toArray(),
      db.categories.toArray(),
      db.goals.filter(alive).toArray(),
      db.goal_moves.filter(alive).toArray(),
      db.limits.filter(alive).toArray(),
    ])
    return { settings, txs, categories, goals, moves, limits }
  }, [db])
  if (!data) return <aside className="daside" aria-label="Обзор" />
  const { settings, txs, categories, goals, moves, limits } = data

  const month = monthOf(today)
  const [, m] = month.split('-').map(Number)
  const spent = daySpend(txs, month)
  const max = Math.max(0, ...spent.values())

  const report = monthReport(txs, month)
  const her = monthReport(byWho(txs, 'partner'), month).totalUsd
  const me = round2(report.totalUsd - her)
  const partner = partnerLabel(settings?.partner_name)
  const byId = new Map<string, Category>(categories.map((c) => [c.id, c]))
  const top = report.byCategory.slice(0, 4).map((c) => ({ ...c, category: categoryOf(c.categoryId, byId) }))

  const liveGoals = goals.filter((g) => !g.archived)
  const liveLimits = limits
    .map((l) => ({ l, c: byId.get(l.category_id) }))
    .filter((x): x is { l: (typeof limits)[number]; c: Category } => !!x.c && alive(x.c) && !x.c.archived)

  return (
    <aside className="daside" aria-label="Обзор">
      <section className="card" aria-label="Календарь месяца">
        <div className="ahead">
          <h3>{MONTHS_NOM[m - 1]}</h3>
          <button type="button" className="lnk" onClick={() => nav.push({ tab: 'home', screen: 'calendar' })}>
            Календарь ›
          </button>
        </div>
        <div className="mcal">
          {WEEKDAYS.map((w) => (
            <span key={w} className="wd">
              {w}
            </span>
          ))}
          {monthDays(month).map((d, i) => {
            if (!d) return <span key={`p${i}`} className="mc pad" />
            const usd = spent.get(d) ?? 0
            const a = max > 0 ? usd / max : 0
            const fut = d > today
            const cls = ['mc', fut && 'fut', d === today && 'today', a > 0.55 && 'hot'].filter(Boolean).join(' ')
            const label = `${dayMonth(d)}: ${usd > 0 ? money(round2(usd), 'USD') : 'без трат'}`
            return (
              <button
                key={d}
                type="button"
                className={cls}
                style={{ '--a': a.toFixed(3) } as CSSProperties}
                title={label}
                aria-label={label}
                disabled={fut}
                onClick={() => nav.push({ tab: 'home', screen: 'calendar', day: d })}
              >
                {Number(d.slice(8))}
              </button>
            )
          })}
        </div>
      </section>

      <section className="card" aria-label="Месяц">
        <div className="ahead">
          <h3>{`Расходы · ${whole(report.totalUsd)}`}</h3>
          <button type="button" className="lnk" onClick={() => nav.open(routeOf('report'))}>
            Отчёт ›
          </button>
        </div>
        {(her > 0 || settings?.partner_name) && (
          <>
            <div className="arow2 label">
              <span className="nm">{`Я ${whole(me)} · ${partner} ${whole(her)}`}</span>
            </div>
            <div className="minibar split" aria-hidden="true">
              <i style={{ width: `${report.totalUsd > 0 ? (me / report.totalUsd) * 100 : 0}%` }} />
              <i style={{ width: `${report.totalUsd > 0 ? (her / report.totalUsd) * 100 : 0}%` }} />
            </div>
          </>
        )}
        {top.length === 0 && <p className="label">Трат в этом месяце нет</p>}
        {top.map((c) => (
          <div key={c.categoryId} className="otop">
            <div className="arow2">
              <CategoryIcon category={c.category} size="sm" />
              <span className="nm">{c.category.name}</span>
              <span className="v">{whole(c.usd)}</span>
            </div>
            <div className="minibar" aria-hidden="true">
              <i style={{ width: `${c.share * 100}%`, background: categoryStyle(c.category).color }} />
            </div>
          </div>
        ))}
      </section>

      {liveGoals.length > 0 && (
        <section className="card" aria-label="Цели">
          <div className="ahead">
            <h3>Цели</h3>
            <button type="button" className="lnk" onClick={() => nav.open(routeOf('goals'))}>
              Все ›
            </button>
          </div>
          {liveGoals.map((g) => {
            const p = goalProgress(g, moves, today)
            return (
              <div key={g.id}>
                <div className="arow2">
                  <span className="nm">{g.name}</span>
                  <span className="v">
                    {whole(p.savedUsd)} <span className="label">{`из ${whole(g.target_usd)}`}</span>
                  </span>
                </div>
                <div className="minibar" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, p.share * 100)}%` }} />
                </div>
              </div>
            )
          })}
        </section>
      )}

      {liveLimits.length > 0 && (
        <section className="card" aria-label="Лимиты">
          <div className="ahead">
            <h3>Лимиты</h3>
            <button type="button" className="lnk" onClick={() => nav.open(routeOf('limits'))}>
              Все ›
            </button>
          </div>
          {liveLimits.map(({ l, c }) => {
            const st = limitStatus(l, txs, month)
            return (
              <div key={l.id} className="olim" data-level={st.level}>
                <div className="arow2">
                  <CategoryIcon category={c} size="sm" />
                  <span className="nm">{c.name}</span>
                  <span className="v">
                    {whole(st.spentUsd)} <span className="label">{`/ ${whole(l.monthly_usd)}`}</span>
                  </span>
                </div>
                <div className={`minibar${st.level === 'ok' ? '' : ` ${st.level}`}`} aria-hidden="true">
                  <i style={{ width: `${Math.min(100, st.share * 100)}%` }} />
                </div>
              </div>
            )
          })}
        </section>
      )}
    </aside>
  )
}
