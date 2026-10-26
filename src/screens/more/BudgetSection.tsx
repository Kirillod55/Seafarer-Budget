import { useEffect, useRef, useState } from 'react'
import { dailyBudget, reservingGoalMoves, reservedUsd } from '@shared/calc.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Account, FxRate, Goal, GoalMove, Settings, Transaction } from '@shared/types.ts'
import { parseAmount } from '../../lib/amount.ts'
import { plural } from '../../ui/dates.ts'
import { MoreCard, onEnter, useSaveSettings } from './common.tsx'

const fmtReserve = (n: number | null | undefined) => String(n ?? 0)

/**
 * «Бюджет до посадки» (spec §2, §4; prototype more()): the landing date and the reserve, and under them the live
 * line «= $X в день на N дней, к посадке останется $R» — it follows what is typed before it is saved. The date is
 * saved when picked, the reserve on leaving the field or Enter; each writes only its own field.
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

  // a change from elsewhere (sync, «Главная») shows up unless the field is being edited
  useEffect(() => setDate(settings.next_contract_date ?? ''), [settings.next_contract_date])
  useEffect(() => {
    if (document.activeElement !== reserveRef.current) setReserve(fmtReserve(settings.reserve_usd))
  }, [settings.reserve_usd])

  const typed = parseAmount(reserve)
  const reserveOk = Number.isFinite(typed) && typed >= 0

  const pickDate = (value: string) => {
    setDate(value)
    const next = value || null
    if (next !== settings.next_contract_date) void save({ next_contract_date: next })
  }

  const commitReserve = () => {
    if (!reserveOk) return setError('Введите сумму')
    setError('')
    const value = round2(typed)
    setReserve(fmtReserve(value))
    if (value !== (settings.reserve_usd ?? 0)) void save({ reserve_usd: value })
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
          <input id="m-board" className="inp" type="date" value={date} onChange={(e) => pickDate(e.target.value)} />
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
