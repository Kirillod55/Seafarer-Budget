import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { daysBetween, localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Settings } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'
import { CUR_BASE, curOptions } from '../ui/currencies.ts'
import { plural } from '../ui/dates.ts'
import { ChevronRight, CreditCard, Wallet, X } from '../ui/icons.ts'
import { Morph } from '../ui/Morph.tsx'
import { prefersReducedMotion } from '../ui/motion.ts'
import { Picker } from '../ui/Picker.tsx'
import { ProgressBar } from '../ui/ProgressBar.tsx'
import './record.css'
import './goals.css'
import './wizard.css'

type Mode = 'single' | 'multi'
type Step = 1 | 2 | 3

interface Row {
  /** stable key (the row's React key and its field ids) */
  k: number
  amount: string
  currency: string
}

/** «до 5 валют» (spec §4) */
const MAX_ROWS = 5
const NOT_A_NUMBER = 'Введите сумму числом, например 5000'
const EASE_IN = 'cubic-bezier(.2,.8,.2,1)'
const EASE_OUT = 'cubic-bezier(.4,0,.2,1)'

const enterRuns = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    run()
  }
}

/** The rows as opening balances; null when a sum is not a number (an empty one is 0). */
function openingOf(rows: Row[]): { currency: string; amount: number }[] | null {
  const out: { currency: string; amount: number }[] = []
  for (const r of rows) {
    const amount = parseAmount(r.amount)
    if (!Number.isFinite(amount)) return null
    out.push({ currency: r.currency, amount: round2(amount) })
  }
  return out
}

/**
 * «Сколько денег сейчас» (spec §4 «Остатки в мастере — несколько валют»; prototype wzCurBlock()/wzRow()/wzAddCur()/
 * wzDelCur()): rows «сумма + валюта»; «+ Ещё валюта» adds a row with the first currency not chosen yet (it unfolds,
 * the cursor goes to its sum), «×» on the extra rows removes one (it folds away); up to 5. The currency menu is the
 * rich one with «Другая валюта…».
 */
function CurrencyRows({
  rows,
  setRows,
  known,
  error,
  onEnter,
}: {
  rows: Row[]
  setRows(update: (rows: Row[]) => Row[]): void
  /** the currencies the menu offers (and «+ Ещё валюта» picks from) after the base ones */
  known: string[]
  error: string
  onEnter(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const nextKey = useRef(rows.reduce((m, r) => Math.max(m, r.k), 0) + 1)
  const added = useRef<number | null>(null)
  const [leaving, setLeaving] = useState<number[]>([])
  const patch = (k: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.k === k ? { ...r, ...p } : r)))
  const live = rows.filter((r) => !leaving.includes(r.k))
  const order = [...CUR_BASE, ...known]

  // a new row unfolds from nothing and takes the cursor
  useLayoutEffect(() => {
    const k = added.current
    if (k === null) return
    added.current = null
    const el = box.current?.querySelector<HTMLElement>(`[data-wk="${k}"]`)
    if (!el) return
    el.querySelector('input')?.focus()
    if (prefersReducedMotion() || typeof el.animate !== 'function') return
    const h = el.offsetHeight
    el.style.overflow = 'clip'
    const a = el.animate(
      [
        { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
        { height: `${h}px`, opacity: 1, transform: 'none' },
      ],
      { duration: 320, easing: EASE_IN },
    )
    a.onfinish = () => (el.style.overflow = '')
  })

  const add = () => {
    if (live.length >= MAX_ROWS) return
    const used = live.map((r) => r.currency)
    const currency = order.find((c) => !used.includes(c)) ?? 'USD'
    const k = nextKey.current++
    added.current = k
    setRows((rs) => [...rs, { k, amount: '', currency }])
  }

  const remove = (k: number) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-wk="${k}"]`)
    const drop = () => {
      setRows((rs) => rs.filter((r) => r.k !== k))
      setLeaving((ks) => ks.filter((x) => x !== k))
    }
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return drop()
    setLeaving((ks) => [...ks, k])
    el.style.overflow = 'clip'
    const a = el.animate([{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], {
      duration: 240,
      easing: EASE_OUT,
      fill: 'forwards',
    })
    a.onfinish = drop
  }

  return (
    <>
      <div ref={box} className="wzcurs rec">
        {rows.map((r) => {
          const i = live.findIndex((x) => x.k === r.k)
          const gone = i < 0
          const n = i + 1
          const amountLabel = n === 1 ? 'Сумма' : `Сумма ${n}`
          const curLabel = n === 1 ? 'Валюта' : `Валюта ${n}`
          return (
            <div key={r.k} className="wzrow" data-wk={r.k} inert={gone || undefined} aria-hidden={gone || undefined}>
              <div className="fld">
                <label htmlFor={`wz-a-${r.k}`} className={n === 1 ? undefined : 'sr'}>
                  {amountLabel}
                </label>
                <input
                  id={`wz-a-${r.k}`}
                  className="inp num"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  aria-invalid={!!error}
                  value={r.amount}
                  onChange={(e) => patch(r.k, { amount: e.target.value })}
                  onKeyDown={enterRuns(onEnter)}
                />
              </div>
              <div className="fld">
                <label htmlFor={`wz-c-${r.k}`} className={n === 1 ? undefined : 'sr'}>
                  Валюта
                </label>
                <Picker
                  id={`wz-c-${r.k}`}
                  label={curLabel}
                  kind="currency"
                  allowOther
                  value={r.currency}
                  options={curOptions([...order, r.currency])}
                  onChange={(currency) => patch(r.k, { currency })}
                />
              </div>
              {n === 1 ? (
                <span className="wzdel sp" aria-hidden="true" />
              ) : (
                <button type="button" className="wzdel" aria-label={`Убрать валюту ${n}`} title="Убрать валюту" onClick={() => remove(r.k)}>
                  <X strokeWidth={2.2} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {error && (
        <p className="gerr" role="alert">
          {error}
        </p>
      )}
      {live.length < MAX_ROWS && (
        <button type="button" className="textbtn wzadd" onClick={add}>
          + Ещё валюта
        </button>
      )}
    </>
  )
}

/** «= $50 в день на 10 дней, к посадке останется $100» from what is typed (spec §4, prototype wizard() step 3). */
function calcLine(
  opening: { currency: string; amount: number }[],
  date: string,
  reserve: number,
  rates: { date: string; currency: string; uah_per_unit: number }[],
  today: string,
): string | { perDay: string; rest: string } {
  if (!date) return 'Без даты бюджет на день не считается — её можно указать позже в «Ещё»'
  if (date < today) return 'Дата посадки уже прошла'
  let total = 0
  for (const o of opening) {
    const r = usdRate(rates, o.currency, today)
    if (r) total += o.amount * r.rate
  }
  const days = daysBetween(today, date) + 1
  const perDay = round2(Math.max(0, total - reserve) / days)
  return {
    perDay: money(perDay, 'USD'),
    rest: ` в день на ${plural(days, 'день', 'дня', 'дней')}, к посадке останется ${money(reserve, 'USD', { whole: true })}`,
  }
}

/*
 * The first-run wizard (spec §4 «Мастер первого запуска», «Остатки в мастере — несколько валют», §6 «вход и мастер —
 * проявление с лёгким масштабом»; prototype wizard()): «Шаг N из 3» with a bar; 1 — «Один баланс / Несколько счетов»;
 * 2 — «Сколько денег сейчас» in up to five currencies; 3 — the landing date (may be skipped) and the reserve with the
 * live «$X в день» line, «Готово» / «Пропустить». It writes the defaults (repo.initDefaults: settings, categories,
 * «Основной» with the opening balances), then the date, the reserve and any new currency as settings fields.
 *
 * startAt="balance" — only the «Остаток» step, for after «Удалить все данные» (Task 13): it writes the opening
 * balances alone (repo.addOpening); settings and accounts stay as they are.
 */
export function Wizard({ onDone, startAt = 'mode' }: { onDone(): void; startAt?: 'mode' | 'balance' }) {
  const { db, repo, now } = useApp()
  const balanceOnly = startAt === 'balance'
  const [step, setStep] = useState<Step>(balanceOnly ? 2 : 1)
  const [mode, setMode] = useState<Mode>('single')
  const [rows, setRows] = useState<Row[]>([{ k: 0, amount: '', currency: DEFAULT_SETTINGS.default_currency }])
  const [date, setDate] = useState('')
  const [reserve, setReserve] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const data = useLiveQuery(async () => {
    const [settings, rates] = await Promise.all([db.settings.filter(alive).first(), db.fx_rates.toArray()])
    return { settings, rates }
  }, [db])

  const settings = data?.settings
  const known = settings?.currencies ?? DEFAULT_SETTINGS.currencies
  const today = localDate(now(), settings?.timezone ?? DEFAULT_SETTINGS.timezone)

  const go = (next: Step) => {
    setError('')
    setStep(next)
  }

  const toLanding = () => {
    if (!openingOf(rows)) return setError(NOT_A_NUMBER)
    go(3)
  }

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      onDone()
    } catch (e) {
      setError(`Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const finishBalance = () => {
    const opening = openingOf(rows)
    if (!opening) return setError(NOT_A_NUMBER)
    void run(() => repo.addOpening(opening))
  }

  const finish = (skip: boolean) => {
    const opening = openingOf(rows)
    if (!opening) return go(2)
    const reserveUsd = skip || reserve.trim() === '' ? 0 : parseAmount(reserve)
    if (!Number.isFinite(reserveUsd) || reserveUsd < 0) return setError('Введите запас числом, например 1000')
    void run(async () => {
      await repo.initDefaults(mode, opening)
      const s = await db.settings.filter(alive).first()
      if (!s) return
      const patch: Partial<Settings> = {}
      const extra = [...new Set(opening.map((o) => o.currency))].filter((c) => !s.currencies.includes(c))
      if (extra.length) patch.currencies = [...s.currencies, ...extra]
      if (!skip && date) patch.next_contract_date = date
      if (!skip && reserveUsd > 0) patch.reserve_usd = round2(reserveUsd)
      if (Object.keys(patch).length) await repo.put<Settings>('settings', { id: s.id, ...patch })
    })
  }

  const choose = (m: Mode) => {
    setMode(m)
    go(2)
  }

  const opening = openingOf(rows) ?? []
  const reserveNum = reserve.trim() === '' ? 0 : parseAmount(reserve)
  const calc = calcLine(opening, date, Number.isFinite(reserveNum) && reserveNum > 0 ? reserveNum : 0, data?.rates ?? [], today)

  return (
    <main className="wz">
      {!balanceOnly && (
        <>
          <div className="wzhead">
            <span className="label">{`Шаг ${step} из 3`}</span>
            {step > 1 && (
              <button type="button" className="textbtn wzback" onClick={() => go((step - 1) as Step)}>
                Назад
              </button>
            )}
          </div>
          <ProgressBar value={step} max={3} thin />
        </>
      )}
      <Morph k={step} className="wzbody">
        {step === 1 ? (
          <div className="wzstep">
            <h1>Добро пожаловать</h1>
            <p className="muted">Как вести деньги?</p>
            <div className="group menu">
              {(
                [
                  ['single', 'Один баланс', 'Всё вместе, без выбора счёта', Wallet, 'var(--acc-1)'],
                  ['multi', 'Несколько счетов', 'Карта, наличные, накопления', CreditCard, 'var(--acc-0)'],
                ] as const
              ).map(([m, title, sub, Icon, color]) => (
                <button key={m} type="button" aria-label={title} aria-describedby={`wz-m-${m}`} onClick={() => choose(m)}>
                  <span className="ic" style={{ '--c': color } as CSSProperties} aria-hidden="true">
                    <Icon strokeWidth={2} />
                  </span>
                  <span className="wzmode">
                    <b>{title}</b>
                    <span id={`wz-m-${m}`} className="label">
                      {sub}
                    </span>
                  </span>
                  <span className="chev" aria-hidden="true">
                    <ChevronRight strokeWidth={2.2} />
                  </span>
                </button>
              ))}
            </div>
            <p className="label">Режим можно поменять потом в «Ещё» — счета и записи останутся.</p>
          </div>
        ) : step === 2 ? (
          <div className="wzstep">
            <h1>Сколько денег сейчас</h1>
            <p className="muted">
              {balanceOnly
                ? 'Данные удалены. Впиши, сколько денег сейчас, — с этого начнётся баланс.'
                : 'Начальный остаток — с него начнётся баланс.'}
            </p>
            <CurrencyRows
              rows={rows}
              setRows={setRows}
              known={known}
              error={error}
              onEnter={balanceOnly ? finishBalance : toLanding}
            />
            {mode === 'multi' && !balanceOnly && (
              <p className="label">Всё ляжет на счёт «Основной»; другие счета добавишь в «Ещё» → «Счета».</p>
            )}
            {balanceOnly ? (
              <div className="wzbtns">
                <button type="button" className="btn-acc" disabled={busy} onClick={finishBalance}>
                  Готово
                </button>
                <button type="button" className="btn-gray" disabled={busy} onClick={onDone}>
                  Пропустить
                </button>
              </div>
            ) : (
              <button type="button" className="btn-acc" onClick={toLanding}>
                Дальше
              </button>
            )}
          </div>
        ) : (
          <div className="wzstep">
            <h1>Бюджет до посадки</h1>
            <p className="muted">Поделю деньги на дни до посадки. Можно пропустить и указать позже.</p>
            <div className="rec">
              <div className="grid2">
                <div className="fld">
                  <label htmlFor="wz-date">Дата посадки</label>
                  <input id="wz-date" className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="fld">
                  <label htmlFor="wz-reserve">Запас, $</label>
                  <input
                    id="wz-reserve"
                    className="inp num"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    aria-invalid={!!error}
                    value={reserve}
                    onChange={(e) => {
                      setReserve(e.target.value)
                      if (error) setError('')
                    }}
                    onKeyDown={enterRuns(() => finish(false))}
                  />
                </div>
              </div>
            </div>
            <p className="calc" aria-live="polite">
              {typeof calc === 'string' ? (
                calc
              ) : (
                <>
                  {'= '}
                  <b className="num">{calc.perDay}</b>
                  {calc.rest}
                </>
              )}
            </p>
            {error && (
              <p className="gerr" role="alert">
                {error}
              </p>
            )}
            <div className="wzbtns">
              <button type="button" className="btn-acc" disabled={busy} onClick={() => finish(false)}>
                Готово
              </button>
              <button type="button" className="btn-gray" disabled={busy} onClick={() => finish(true)}>
                Пропустить
              </button>
            </div>
          </div>
        )}
      </Morph>
    </main>
  )
}
