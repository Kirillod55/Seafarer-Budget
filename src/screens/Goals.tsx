import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { goalProgress } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Goal, GoalMove, Settings } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { useNav } from '../nav/Navigator.tsx'
import { curLabel, curName } from '../ui/currencies.ts'
import { MONTHS_DAT } from '../ui/dates.ts'
import { Plus, Target } from '../ui/icons.ts'
import { Picker } from '../ui/Picker.tsx'
import { ProgressBar } from '../ui/ProgressBar.tsx'
import { useToast } from '../ui/Toast.tsx'
import { useFlip } from '../ui/useFlip.ts'
import { useDayTick } from './Home.tsx'
import './record.css'
import './goals.css'

const FAILED = 'Не получилось — попробуй ещё раз'

/** Goal sums are whole dollars, as in the prototype («$300 из $15,000», «Нужно откладывать $76 в месяц»). */
const usd = (n: number) => money(n, 'USD', { whole: true })

/** «Наберётся к июлю 2035» (spec §6): the month in the dative and the year. */
export function untilMonth(date: string): string {
  return `${MONTHS_DAT[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
}

/** Which goal has its «Отложить / Забрать» form open, or the «Новая цель» card; one at a time. */
type Panel = { kind: 'new' } | { kind: 'move'; goalId: string } | null

const enterSubmits = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    run()
  }
}

/** «Новая цель» (prototype goals(), S.goalNew): name, target in $, an optional deadline; «Создать» / «Отмена». */
function NewGoalCard({ onClose }: { onClose(): void }) {
  const { repo } = useApp()
  const toast = useToast()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [errors, setErrors] = useState<{ name?: string; target?: string }>({})
  const [busy, setBusy] = useState(false)

  async function save() {
    if (busy) return
    const value = parseAmount(target)
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Введите название'
    if (!(value > 0)) next.target = 'Введите сумму'
    setErrors(next)
    if (next.name || next.target) return
    setBusy(true)
    try {
      const n = name.trim()
      await repo.put<Goal>('goals', {
        name: n.charAt(0).toUpperCase() + n.slice(1),
        target_usd: round2(value),
        deadline: deadline || null,
        archived: false,
      })
      onClose()
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  const submit = enterSubmits(() => void save())

  return (
    <section className="card gcard rec reveal" data-flip-key="new-goal" aria-labelledby="g-new-title">
      <h3 id="g-new-title">Новая цель</h3>
      <div className="fld">
        <label htmlFor="g-name">Название</label>
        <input
          id="g-name"
          className="inp"
          type="text"
          placeholder="Машина"
          autoComplete="off"
          aria-invalid={!!errors.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={submit}
        />
      </div>
      <div className="grid2">
        <div className="fld">
          <label htmlFor="g-target">Цель, $</label>
          <input
            id="g-target"
            className="inp num"
            type="text"
            inputMode="decimal"
            placeholder="15000"
            autoComplete="off"
            aria-invalid={!!errors.target}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={submit}
          />
        </div>
        <div className="fld">
          <label htmlFor="g-deadline">Срок</label>
          <input id="g-deadline" className="inp" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </div>
      {(errors.name || errors.target) && (
        <div className="gerr" role="alert">
          {errors.name && <p>{errors.name}</p>}
          {errors.target && <p>{errors.target}</p>}
        </div>
      )}
      <div className="gacts">
        <button type="button" className="btn-acc" disabled={busy} onClick={() => void save()}>
          Создать
        </button>
        <button type="button" className="btn-gray" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </section>
  )
}

/** The form that shows inside a goal's card: amount and currency, «Отложить» / «Забрать» / «Отмена». */
function MoveForm({
  goal,
  savedUsd,
  settings,
  today,
  onClose,
}: {
  goal: Goal
  /** what the goal holds now: «Забрать» stops at 0 (prototype: saved = max(0, saved − amount)) */
  savedUsd: number
  settings: Settings
  today: string
  onClose(): void
}) {
  const { db, repo, now } = useApp()
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(settings.default_currency)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const currencies = settings.currencies.includes(currency) ? settings.currencies : [...settings.currencies, currency]

  async function save(take: boolean) {
    if (busy) return
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    if (take && !(savedUsd > 0)) return setError('На цели пока ничего нет')
    setBusy(true)
    try {
      // the latest rate known for today (R23); USD always converts at 1
      const found = usdRate(await db.fx_rates.toArray(), currency, today)
      if (!found) return setError('Нет курса для этой валюты')
      const usdAmount = round2(value * found.rate)
      await repo.put<GoalMove>('goal_moves', {
        goal_id: goal.id,
        amount_usd: take ? -Math.min(usdAmount, round2(savedUsd)) : usdAmount,
        date: today,
        note: '',
        author: 'owner',
        source: 'app',
        created_at: now().toISOString(),
      })
      onClose()
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gmove rec reveal">
      <div className="grid2">
        <div className="fld">
          <label htmlFor={`m-amt-${goal.id}`}>Сумма</label>
          <input
            id={`m-amt-${goal.id}`}
            className="inp num"
            type="text"
            inputMode="decimal"
            placeholder="100"
            autoComplete="off"
            aria-invalid={!!error}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={enterSubmits(() => void save(false))}
          />
        </div>
        <div className="fld">
          <label htmlFor={`m-cur-${goal.id}`}>Валюта</label>
          <Picker
            id={`m-cur-${goal.id}`}
            label="Валюта"
            kind="currency"
            value={currency}
            options={currencies.map((c) => ({ value: c, label: curLabel(c), sub: curName(c) }))}
            onChange={setCurrency}
          />
        </div>
      </div>
      {error && (
        <p className="gerr" role="alert">
          {error}
        </p>
      )}
      <div className="gacts">
        <button type="button" className="btn-acc" disabled={busy} onClick={() => void save(false)}>
          Отложить
        </button>
        <button type="button" className="btn-gray" disabled={busy} onClick={() => void save(true)}>
          Забрать
        </button>
        <button type="button" className="textbtn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}

function GoalCard({
  goal,
  moves,
  settings,
  today,
  open,
  onPanel,
  onArchive,
}: {
  goal: Goal
  moves: GoalMove[]
  settings: Settings
  today: string
  open: boolean
  onPanel(p: Panel): void
  onArchive(goal: Goal): void
}) {
  const p = goalProgress(goal, moves, today)
  const reached = goal.target_usd > 0 && p.savedUsd >= goal.target_usd
  const percent = Math.round(Math.min(1, Math.max(0, p.share)) * 100)
  const eta = reached ? 'Цель достигнута' : p.etaDate ? `Наберётся к ${untilMonth(p.etaDate)}` : 'Темп пока не определён'
  const titleId = `goal-${goal.id}`

  return (
    <section className="card gcard" data-flip-key={`goal-${goal.id}`} aria-labelledby={titleId}>
      <div className="ghead">
        <span className="gname">
          <span className="ic" style={{ '--c': 'var(--anchor)' } as CSSProperties} aria-hidden="true">
            <Target strokeWidth={2} />
          </span>
          <h3 id={titleId}>{goal.name}</h3>
        </span>
        <span className="gsum num">
          <span>{usd(p.savedUsd)}</span>
          <span className="label">{`из ${usd(goal.target_usd)}`}</span>
        </span>
      </div>
      <ProgressBar value={p.share} max={1} thin />
      <div className="gmeta label">
        <span>{eta}</span>
        <span className="num">{`${percent}%`}</span>
      </div>
      {!reached && p.perMonthNeeded !== null && p.perMonthNeeded > 0 && (
        <p className="need">{`Нужно откладывать ${usd(p.perMonthNeeded)} в месяц`}</p>
      )}
      {open ? (
        <MoveForm goal={goal} savedUsd={p.savedUsd} settings={settings} today={today} onClose={() => onPanel(null)} />
      ) : (
        <div className="goalacts">
          <button type="button" className="btn-gray" onClick={() => onPanel({ kind: 'move', goalId: goal.id })}>
            Отложить или забрать
          </button>
          <button type="button" className="btn-tint" onClick={() => onArchive(goal)}>
            В архив
          </button>
        </div>
      )}
    </section>
  )
}

/*
 * «Цели» (spec §6 «Цели: кнопки в одну строку», «Нужно откладывать…», «Наберётся к июлю 2035»; §4 «Архив»;
 * prototype goals()): «＋ Добавить» in the bar opens the «Новая цель» card; each goal card — icon, name, saved
 * «из» target, a thin bar, the ETA and %, «Нужно откладывать $X в месяц» for a deadline, then one row «Отложить
 * или забрать» (grey, the rest of the width) + «В архив» (lime tint). The move form shows inside the card.
 * Only alive, non-archived goals are listed (archived and binned goals reserve nothing — reservingGoalMoves);
 * «Архив целей · N» opens the archive. Adding, archiving and opening forms re-flow smoothly (useFlip).
 */
export function Goals() {
  const { db, repo, now } = useApp()
  const nav = useNav()
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const data = useLiveQuery(async () => {
    const [settings, goals, moves] = await Promise.all([
      db.settings.filter(alive).first(),
      db.goals.filter(alive).toArray(),
      db.goal_moves.filter(alive).toArray(),
    ])
    return { settings, goals, moves }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  const active = data?.goals.filter((g) => !g.archived) ?? []
  const archivedCount = (data?.goals.length ?? 0) - active.length
  const panelKey = panel ? (panel.kind === 'new' ? 'new' : panel.goalId) : ''
  useFlip(screenRef, [active.map((g) => g.id).join(','), archivedCount, panelKey, !!data])

  async function archive(goal: Goal) {
    if (panel?.kind === 'move' && panel.goalId === goal.id) setPanel(null)
    try {
      await repo.put<Goal>('goals', { id: goal.id, archived: true })
      toast('Цель в архиве', { label: 'Отменить', run: () => repo.put<Goal>('goals', { id: goal.id, archived: false }) })
    } catch {
      toast(FAILED)
    }
  }

  const settings = data?.settings
  const today = localDate(now(), settings?.timezone ?? 'UTC')

  return (
    <div ref={screenRef} className="goals">
      <NavBar
        title="Цели"
        trailing={
          <button type="button" className="navbtn strong" onClick={() => setPanel({ kind: 'new' })}>
            <Plus aria-hidden="true" strokeWidth={2.4} />
            Добавить
          </button>
        }
      />
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : !settings ? (
        <p className="muted">Сначала завершите настройку</p>
      ) : (
        <>
          {panel?.kind === 'new' && <NewGoalCard onClose={() => setPanel(null)} />}
          {active.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              moves={data.moves}
              settings={settings}
              today={today}
              open={panel?.kind === 'move' && panel.goalId === g.id}
              onPanel={setPanel}
              onArchive={(goal) => void archive(goal)}
            />
          ))}
          {active.length === 0 && panel?.kind !== 'new' && (
            <p className="muted gempty" data-flip-key="empty">
              Целей пока нет
            </p>
          )}
          {archivedCount > 0 && (
            <button
              type="button"
              className="textbtn garch"
              data-flip-key="archive-link"
              onClick={() => nav.push({ tab: 'goals', screen: 'archive' })}
            >
              {`Архив целей · ${archivedCount}`}
            </button>
          )}
          <p className="label gfoot" data-flip-key="foot">
            Отложенное на цели — часть баланса, помеченная «не трогать»: оно вычитается из «Свободно» и не входит в
            бюджет на день.
          </p>
        </>
      )}
    </div>
  )
}
