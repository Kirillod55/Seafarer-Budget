import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { activeBalances, balanceUsd, dailyBudget, reservingGoalMoves, reservedUsd, type DailyBudget } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Settings } from '@shared/types.ts'
import { DayGroups } from '../components/DayGroups.tsx'
import { QuickInput } from '../components/QuickInput.tsx'
import { SyncCloud, isNetworkError } from '../components/SyncCloud.tsx'
import { useApp } from '../context.tsx'
import { useNav, useScreenActive } from '../nav/Navigator.tsx'
import { ProgressBar } from '../ui/ProgressBar.tsx'
import { PullToRefresh } from '../ui/PullToRefresh.tsx'
import { dayMonth, weekdayDayMonth } from '../ui/dates.ts'
import { Anchor, Calendar, Plus } from '../ui/icons.ts'
import { useCountUp } from '../ui/useCountUp.ts'
import { useRecordSheet } from './RecordSheet.tsx'
import './home.css'

/** A pull to refresh never waits longer than this for the server. */
const REFRESH_TIMEOUT_MS = 15000

const usd = (n: number) => money(n, 'USD')
const usdWhole = (n: number) => money(n, 'USD', { whole: true })

/** A USD amount that counts to its new value (spec §6 «Цифры … плавно досчитываются», 0.6 s). */
function CountUp({ value, className }: { value: number; className: string }) {
  const shown = useCountUp(value)
  return <span className={className}>{usd(shown)}</span>
}

/*
 * The home screen (spec §3, top to bottom; prototype home()): the date pill (→ the calendar), the sync cloud and
 * «＋»; the balance with «Свободно / Запас / Посадка» under it; the day card by the §2 states; the quick input;
 * the latest records. Pull down syncs.
 */
export function Home() {
  const { db, now, scheduler } = useApp()
  const { openRecord } = useRecordSheet()
  const nav = useNav()
  const active = useScreenActive()
  const data = useLiveQuery(async () => {
    const [settings, txs, rates, moves, goals, categories, accounts] = await Promise.all([
      db.settings.filter(alive).first(),
      db.transactions.filter(alive).toArray(),
      db.fx_rates.toArray(),
      db.goal_moves.filter(alive).toArray(),
      db.goals.toArray(),
      db.categories.toArray(),
      db.accounts.toArray(),
    ])
    return { settings, txs, rates, moves, goals, categories, accounts }
  }, [db])

  const refresh = async () => {
    if (!navigator.onLine) throw new Error('Нет сети — отправлю, когда появится связь')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Сервер не отвечает — попробую позже')), REFRESH_TIMEOUT_MS)
    })
    try {
      const status = await Promise.race([scheduler.syncNow(), timeout])
      if (status.state === 'error') {
        throw new Error(isNetworkError(status.error ?? '') ? 'Нет связи с сервером' : 'Не удалось синхронизировать')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, txs, rates, moves, goals, categories, accounts } = data
  if (!settings) return <QuickInput />

  const today = localDate(now(), settings.timezone)
  const bal = activeBalances(txs, accounts) // archived accounts are not money on hand
  const balance = balanceUsd(bal, rates, today)
  const reserved = reservedUsd(reservingGoalMoves(moves, goals)) // a goal in the bin or the archive reserves nothing
  const reserve = settings.reserve_usd ?? 0
  const free = Math.max(0, round2(balance - reserved - reserve))
  const noRate = Object.keys(bal).filter((cur) => bal[cur] !== 0 && !usdRate(rates, cur, today))
  const budget = dailyBudget({ txs, rates, accounts, reservedUsd: reserved, settings, today })
  const landing = settings.next_contract_date

  return (
    <PullToRefresh onRefresh={refresh} disabled={!active}>
      <div className="home">
        <div className="home-top">
          <button type="button" className="navbtn datebtn" onClick={() => nav.push({ tab: 'home', screen: 'calendar' })}>
            <span>{`Сегодня, ${dayMonth(today)}`}</span>
            <Calendar aria-hidden="true" strokeWidth={1.8} />
          </button>
          <span className="home-top-r">
            <SyncCloud />
            <button type="button" className="addbtn" aria-label="Новая запись" onClick={() => openRecord()}>
              <Plus aria-hidden="true" strokeWidth={2.6} />
            </button>
          </span>
        </div>

        <section className="home-bal" aria-label="Баланс">
          <p className="label">Баланс</p>
          <CountUp className="balance num" value={balance} />
          {noRate.length > 0 && <p className="label">{`Курс ${noRate.join(', ')} загрузится при синхронизации`}</p>}
          <div className="stats num">
            <div className="stat">
              {reserve > 0 && (
                <>
                  <span className="label">Свободно</span>
                  <span className="v">{usdWhole(free)}</span>
                </>
              )}
            </div>
            <div className="stat">
              {reserve > 0 && (
                <>
                  <span className="label">Запас</span>
                  <span className="v">{usdWhole(reserve)}</span>
                </>
              )}
            </div>
            <div className="stat">
              {landing && (
                <>
                  <span className="label">Посадка</span>
                  <span className="v board">
                    <Anchor className="anchor" aria-hidden="true" strokeWidth={2.2} />
                    {weekdayDayMonth(landing)}
                  </span>
                </>
              )}
            </div>
          </div>
        </section>

        <DayCard budget={budget} settings={settings} today={today} onSettings={() => nav.switchTab('more')} />

        <QuickInput />

        <DayGroups
          txs={txs.filter((t) => t.date <= today)}
          categories={categories}
          accounts={accounts}
          partnerName={settings.partner_name}
          today={today}
          maxDays={3}
          onOpen={openRecord}
        />
      </div>
    </PullToRefresh>
  )
}

/** The day card (spec §2 «Состояния», §3 item 4). */
function DayCard({
  budget: b,
  settings,
  today,
  onSettings,
}: {
  budget: DailyBudget
  settings: Settings
  today: string
  onSettings(): void
}) {
  if (b.state === 'no_date' || b.state === 'sea') {
    const sea = b.state === 'sea'
    return (
      <section className="daycard" data-state={b.state} aria-label="Сегодня">
        <div className="dc-row">
          <CountUp className="dc-spent num" value={b.spentToday} />
          <span className="label">Потрачено сегодня</span>
        </div>
        {sea ? (
          <p className="dc-note">Ты в рейсе — бюджет на день не считается. Вернулся? Укажи новую дату посадки.</p>
        ) : (
          <p className="dc-note">
            <Anchor className="anchor" aria-hidden="true" strokeWidth={2.2} />
            Укажи дату посадки — посчитаю бюджет на каждый день.
          </p>
        )}
        <LandingDate settings={settings} today={today} label={sea ? 'Новая дата посадки' : 'Указать дату'} primary={!sea} />
        <button type="button" className="dc-link" onClick={onSettings}>
          Запас к посадке — в «Ещё»
        </button>
      </section>
    )
  }

  const over = b.leftToday < 0
  return (
    <section className="daycard" data-state={b.state} aria-label="Сегодня">
      <div className="dc-row label">
        <span>Потрачено сегодня</span>
        <span>Бюджет на день</span>
      </div>
      <div className="dc-row">
        <CountUp className="dc-spent num" value={b.spentToday} />
        <CountUp className="dc-limit num" value={b.perDay} />
      </div>
      <ProgressBar value={over ? 1 : b.spentToday} max={over ? 1 : b.perDay} level={over ? 'over' : 'ok'} />
      <div className="dc-row small">
        <span className={`${over ? 'over-text' : 'left'} num`}>
          {over ? `Перерасход ${usd(-b.leftToday)}` : `Осталось ${usd(b.leftToday)}`}
        </span>
        <span className="label num">{`${usdWhole(Math.max(0, b.freeMorningUsd))} ÷ ${b.days} дн`}</span>
      </div>
      {b.state === 'reserve' && (
        <p className="dc-note danger">{`Ты тратишь запас к посадке. Бюджет на день — ${usd(0)}.`}</p>
      )}
    </section>
  )
}

/** «Указать дату» → a date field; saves only next_contract_date (settings are written field by field). */
function LandingDate({ settings, today, label, primary }: { settings: Settings; today: string; label: string; primary: boolean }) {
  const { repo } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) {
    return (
      <button type="button" className={primary ? 'dc-btn' : 'dc-btn gray'} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!value || busy) return
    setBusy(true)
    try {
      await repo.put<Settings>('settings', { id: settings.id, next_contract_date: value })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="dc-form" onSubmit={save}>
      <label className="label" htmlFor="landing-date">
        Дата посадки
      </label>
      <input id="landing-date" className="dc-date" type="date" min={today} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="dc-acts">
        <button type="submit" className="dc-btn" disabled={!value || busy}>
          Сохранить
        </button>
        <button type="button" className="dc-btn gray" onClick={() => setOpen(false)}>
          Отмена
        </button>
      </div>
    </form>
  )
}
