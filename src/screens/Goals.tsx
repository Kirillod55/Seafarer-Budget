import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { goalProgress } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Goal, GoalMove, Settings } from '@shared/types.ts'
import { ProgressBar } from '../ui/ProgressBar.tsx'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'

const usd = (n: number) => money(n, 'USD')

/** 2026-10-21 -> 21.10.2026 */
const ruDate = (date: string) => `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}`

type Panel = { kind: 'new' } | { kind: 'move'; goalId: string; take: boolean } | null

function NewGoalForm({ onClose }: { onClose(): void }) {
  const { repo } = useApp()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [errors, setErrors] = useState<{ name?: string; target?: string }>({})
  const [busy, setBusy] = useState(false)

  async function save() {
    const value = parseAmount(target)
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Введите название'
    if (!(value > 0)) next.target = 'Введите сумму'
    setErrors(next)
    if (next.name || next.target) return
    setBusy(true)
    try {
      await repo.put<Goal>('goals', { name: name.trim(), target_usd: value, deadline: deadline || null, archived: false })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>Новая цель</h2>
      <div>
        <label htmlFor="goal-name">Название</label>
        <input id="goal-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        {errors.name && (
          <p className="error" role="alert">
            {errors.name}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="goal-target">Цель, $</label>
        <input
          id="goal-target"
          className="field"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        {errors.target && (
          <p className="error" role="alert">
            {errors.target}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="goal-deadline">Срок (необязательно)</label>
        <input id="goal-deadline" className="field" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

function MoveForm({
  goal,
  take,
  settings,
  today,
  onClose,
}: {
  goal: Goal
  take: boolean
  settings: Settings
  today: string
  onClose(): void
}) {
  const { db, repo } = useApp()
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(settings.default_currency)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    setBusy(true)
    try {
      // the latest rate known for today (R23); USD always converts at 1
      const found = usdRate(await db.fx_rates.toArray(), currency, today)
      if (!found) return setError('Нет курса для этой валюты')
      const usdAmount = round2(value * found.rate)
      await repo.put<GoalMove>('goal_moves', {
        goal_id: goal.id,
        amount_usd: take ? -usdAmount : usdAmount,
        date: today,
        note: '',
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="row">
        <div className="grow">
          <label htmlFor="move-amount">Сумма</label>
          <input
            id="move-amount"
            className="field"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="w-cur">
          <label htmlFor="move-currency">Валюта</label>
          <select id="move-currency" className="field" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {settings.currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

function GoalCard({
  goal,
  moves,
  settings,
  today,
  panel,
  onPanel,
}: {
  goal: Goal
  moves: GoalMove[]
  settings: Settings
  today: string
  panel: Panel
  onPanel(p: Panel): void
}) {
  const { repo } = useApp()
  const p = goalProgress(goal, moves, today)
  const open = panel?.kind === 'move' && panel.goalId === goal.id ? panel : null

  return (
    <section className="card stack" aria-label={goal.name}>
      <h2>{goal.name}</h2>
      <ProgressBar value={p.share} max={1} />
      <p>{`${usd(p.savedUsd)} из ${usd(goal.target_usd)}`}</p>
      <p className="muted small">{p.etaDate ? `наберётся к ${ruDate(p.etaDate)}` : 'темп пока не определён'}</p>
      {p.perMonthNeeded !== null && p.perMonthNeeded > 0 && (
        <p className="muted small">{`нужно откладывать ${usd(p.perMonthNeeded)} в месяц`}</p>
      )}
      {open ? (
        <MoveForm goal={goal} take={open.take} settings={settings} today={today} onClose={() => onPanel(null)} />
      ) : (
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onPanel({ kind: 'move', goalId: goal.id, take: false })}>
            Отложить
          </button>
          <button type="button" className="btn grow" onClick={() => onPanel({ kind: 'move', goalId: goal.id, take: true })}>
            Забрать
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void repo.put<Goal>('goals', { id: goal.id, archived: true })}
          >
            В архив
          </button>
        </div>
      )}
    </section>
  )
}

export function Goals() {
  const { db, now } = useApp()
  const [panel, setPanel] = useState<Panel>(null)
  const data = useLiveQuery(async () => {
    const [settings, goals, moves] = await Promise.all([
      db.settings.filter(alive).first(),
      db.goals.filter((g) => alive(g) && !g.archived).toArray(),
      db.goal_moves.filter(alive).toArray(),
    ])
    return { settings, goals, moves }
  }, [db])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, goals, moves } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>
  const today = localDate(now(), settings.timezone)

  return (
    <div className="stack">
      <h2>Цели</h2>
      {panel?.kind === 'new' ? (
        <NewGoalForm onClose={() => setPanel(null)} />
      ) : (
        <button type="button" className="btn btn-block" onClick={() => setPanel({ kind: 'new' })}>
          + Цель
        </button>
      )}
      {goals.length === 0 && panel?.kind !== 'new' && <p className="muted empty">Целей пока нет</p>}
      {goals.map((g) => (
        <GoalCard key={g.id} goal={g} moves={moves} settings={settings} today={today} panel={panel} onPanel={setPanel} />
      ))}
    </div>
  )
}
