import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { activeBalances, allowance, balanceUsd, contractStats, reservingGoalMoves, reservedUsd } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Settings } from '@shared/types.ts'
import { QuickInput } from '../components/QuickInput.tsx'
import { TxList } from '../components/TxList.tsx'
import { useApp } from '../context.tsx'

const usd = (n: number, whole = true) => money(n, 'USD', { whole })

function ContractDate({ settings }: { settings: Settings }) {
  const { repo } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-block" onClick={() => setOpen(true)}>
        Указать дату контракта
      </button>
    )
  }
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!value) return
        await repo.put<Settings>('settings', { ...settings, next_contract_date: value })
        setOpen(false)
      }}
    >
      <label htmlFor="contract-date">Дата следующего контракта</label>
      <input id="contract-date" className="field" type="date" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={!value}>
          Сохранить
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
      </div>
    </form>
  )
}

export function Home({ onOpenRecord }: { onOpenRecord?(id?: string): void } = {}) {
  const { db, now } = useApp()
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

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, txs, rates, moves, goals, categories, accounts } = data

  const quick = <QuickInput />
  if (!settings) return <div className="stack">{quick}</div>

  const today = localDate(now(), settings.timezone)
  const bal = activeBalances(txs, accounts) // archived accounts are not free money
  const reserved = reservedUsd(reservingGoalMoves(moves, goals)) // a goal in the bin or the archive reserves nothing
  const freeUsd = round2(balanceUsd(bal, rates, today) - reserved)
  const noRate = Object.keys(bal).filter((cur) => bal[cur] !== 0 && !usdRate(rates, cur, today))
  const al = allowance(freeUsd, settings, today)
  const stats = settings.status === 'contract' ? contractStats(txs, settings, today) : null
  const cls = (n: number) => (n < 0 ? ' neg' : '')

  return (
    <div className="stack">
      {quick}

      <button type="button" className="btn btn-block" onClick={() => onOpenRecord?.(undefined)}>
        + Запись
      </button>

      <section className="card">
        <p className="label">Свободные деньги</p>
        <p className={`big${cls(freeUsd)}`}>{usd(freeUsd, false)}</p>
        <p className="muted small">
          {Object.entries(bal)
            .filter(([, v]) => v !== 0)
            .map(([cur, v]) => money(v, cur))
            .join(' · ') || 'Баланс пуст'}
        </p>
        {reserved > 0 && <p className="muted small">{`Отложено на цели: ${usd(reserved, false)}`}</p>}
        {noRate.length > 0 && <p className="muted small">{`Курс ${noRate.join(', ')} загрузится при синхронизации`}</p>}
      </section>

      {stats ? (
        <section className="card">
          <dl className="stats">
            <div>
              <dt>Заработано за контракт</dt>
              <dd>{usd(stats.earnedUsd)}</dd>
            </div>
            <div>
              <dt>Отложено в этом месяце</dt>
              <dd className={cls(stats.savedThisMonthUsd).trim()}>{usd(stats.savedThisMonthUsd)}</dd>
            </div>
            {stats.projectedUsd !== null && (
              <div>
                <dt>Прогноз накоплений к концу контракта</dt>
                <dd className={cls(stats.projectedUsd).trim()}>{usd(stats.projectedUsd)}</dd>
              </div>
            )}
          </dl>
        </section>
      ) : (
        <section className="card stack">
          <p className="label">Можно тратить</p>
          {al.status === 'ok' ? (
            <>
              <p className={`allow allow-month${cls(al.perMonth)}`}>{`${usd(al.perMonth)} в месяц`}</p>
              <p className={`allow allow-day${cls(al.perDay)}`}>{`${usd(al.perDay)} в день`}</p>
              <p className="muted small">{`до выплаты за контракт осталось ${al.days} дн.`}</p>
            </>
          ) : (
            <>
              <p className="muted">
                {al.status === 'expired' ? 'Дата контракта уже прошла.' : 'Чтобы посчитать, сколько можно тратить, нужна дата следующего контракта.'}
              </p>
              <ContractDate settings={settings} />
            </>
          )}
        </section>
      )}

      <section>
        <h2>Последние записи</h2>
        <TxList txs={txs} categories={categories} onSelect={onOpenRecord} />
      </section>
    </div>
  )
}
