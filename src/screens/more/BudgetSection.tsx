import { useEffect, useRef, useState } from 'react'
import { dailyBudget, reservingGoalMoves, reservedUsd } from '@shared/calc.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Account, FxRate, Goal, GoalMove, Settings, Transaction } from '@shared/types.ts'
import { parseAmount } from '../../lib/amount.ts'
import { plural } from '../../ui/dates.ts'
import { MoreCard, useSaveSettings } from './common.tsx'
import { onEnter } from '../../ui/keys.ts'

const fmtReserve = (n: number | null | undefined) => String(n ?? 0)

/**
 * «Бюджет до посадки» (spec §2, §4; prototype more()): the landing date and the reserve, and under them the live
 * line «= $X в день на N дней, к посадке останется $R» — it follows what is typed before it is saved. The date is
 * saved when a full date is picked (an emptied field clears it on blur), the reserve on leaving the field or
 * Enter; each writes only its own field.
 */
export function BudgetSection({
  settings,
  txs,
  rates,
  moves,
  goals,
  accounts,
  today,
}: {
  settings: Settings
  txs: Transaction[]
  rates: FxRate[]
  moves: GoalMove[]
  goals: Goal[]
  accounts: Account[]
  today: string
}) {
  const save = useSaveSettings(settings)
  const [date, setDate] = useState(settings.next_contract_date ?? '')
  const [reserve, setReserve] = useState(fmtReserve(settings.reserve_usd))
  const [error, setError] = useState('')
  const reserveRef = useRef<HTMLInputElement>(null)

  // A change from elsewhere (sync, «Главная») shows up unless the field is being edited. `known` holds the stored
  // values the fields already account for — the first render's and our own saves' — so neither the mount nor the
  // echo of a save (which can arrive after the next keystroke) puts an older value back over what is being typed.
  const known = useRef({ date: settings.next_contract_date, reserve: settings.reserve_usd })
  useEffect(() => {
    if (settings.next_contract_date === known.current.date) return
    known.current.date = settings.next_contract_date
    setDate(settings.next_contract_date ?? '')
  }, [settings.next_contract_date])
  useEffect(() => {
    if (settings.reserve_usd === known.current.reserve) return
    known.current.reserve = settings.reserve_usd
    if (document.activeElement !== reserveRef.current) setReserve(fmtReserve(settings.reserve_usd))
  }, [settings.reserve_usd])

  const typed = parseAmount(reserve)
  const reserveOk = Number.isFinite(typed) && typed >= 0

  // a native date field reports '' while a part of it is being retyped: only a full date is saved at once;
  // a field left empty clears the date when it loses focus
  const pickDate = (value: string) => {
    setDate(value)
    if (value && value !== settings.next_contract_date) {
      known.current.date = value
      void save({ next_contract_date: value })
    }
  }
  const leaveDate = () => {
    if (!date && settings.next_contract_date) {
      known.current.date = null
      void save({ next_contract_date: null })
    }
  }

  const commitReserve = () => {
    if (!reserveOk) return setError('Введите сумму')
    setError('')
    const value = round2(typed)
    setReserve(fmtReserve(value))
    if (value !== (settings.reserve_usd ?? 0)) {
      known.current.reserve = value
      void save({ reserve_usd: value })
    }
  }

  const reserveUsd = reserveOk ? round2(typed) : (settings.reserve_usd ?? 0)
  const b = dailyBudget({
    txs,
    rates,
    accounts,
    reservedUsd: reservedUsd(reservingGoalMoves(moves, goals)),
    settings: { next_contract_date: date || null, reserve_usd: reserveUsd },
    today,
  })

  return (
    <MoreCard title="Бюджет до посадки">
      <div className="grid2">
        <div className="fld">
          <label htmlFor="m-board">Дата посадки</label>
          <input
            id="m-board"
            className="inp"
            type="date"
            value={date}
            onChange={(e) => pickDate(e.target.value)}
            onBlur={leaveDate}
          />
        </div>
        <div className="fld">
          <label htmlFor="m-reserve">Запас, $</label>
          <input
            ref={reserveRef}
            id="m-reserve"
            className="inp num"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            aria-invalid={!!error}
            aria-describedby="m-calc"
            value={reserve}
            onChange={(e) => {
              setReserve(e.target.value)
              if (error) setError('')
            }}
            onBlur={commitReserve}
            onKeyDown={onEnter(commitReserve)}
          />
        </div>
      </div>
      {error && (
        <p className="merr" role="alert">
          {error}
        </p>
      )}
      <p className="calc" id="m-calc" aria-live="polite">
        {b.state === 'no_date' ? (
          'Без даты бюджет на день не считается'
        ) : b.state === 'sea' ? (
          'Дата посадки уже прошла'
        ) : (
          <>
            {'= '}
            <b className="num">{money(b.perDay, 'USD')}</b>
            {` в день на ${plural(b.days, 'день', 'дня', 'дней')}, к посадке останется ${money(reserveUsd, 'USD', { whole: true })}`}
          </>
        )}
      </p>
    </MoreCard>
  )
}
