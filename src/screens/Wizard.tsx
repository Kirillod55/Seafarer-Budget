import { useState } from 'react'
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { useApp } from '../context.tsx'

interface Row {
  name: string
  currency: string
  amount: string
}

type Mode = 'single' | 'multi'

const CURRENCIES = DEFAULT_SETTINGS.currencies
const newRow = (): Row => ({ name: '', currency: DEFAULT_SETTINGS.default_currency, amount: '' })

/** Empty means 0; accepts "1 200,5". Returns null when it is not a number. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.')
  if (cleaned === '') return 0
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function CurrencySelect({ id, value, onChange }: { id: string; value: string; onChange(v: string): void }) {
  return (
    <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      {CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}

export function Wizard({ onDone }: { onDone(): void }) {
  const { repo } = useApp()
  const [mode, setMode] = useState<Mode | null>(null)
  const [rows, setRows] = useState<Row[]>([newRow()])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)))

  async function finish() {
    if (!mode) return
    const used = mode === 'single' ? rows.slice(0, 1) : rows
    const opening: { currency: string; amount: number; accountName?: string }[] = []
    for (const r of used) {
      const amount = parseAmount(r.amount)
      if (amount === null) {
        setError('Введите сумму числом, например 5000')
        return
      }
      opening.push(mode === 'single' ? { currency: r.currency, amount } : { currency: r.currency, amount, accountName: r.name.trim() })
    }
    setError(null)
    setBusy(true)
    try {
      await repo.initDefaults(mode, opening)
      onDone()
    } catch (e) {
      setError(`Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page narrow">
      <h1>Добро пожаловать</h1>
      <p className="muted">Расскажите, сколько у вас сейчас денег. Позже это можно поменять.</p>

      <div className="choice" role="group" aria-label="Как вы хотите вести учёт">
        <button type="button" className={`btn choice-btn${mode === 'single' ? ' active' : ''}`} aria-pressed={mode === 'single'} onClick={() => setMode('single')}>
          Один баланс
        </button>
        <button type="button" className={`btn choice-btn${mode === 'multi' ? ' active' : ''}`} aria-pressed={mode === 'multi'} onClick={() => setMode('multi')}>
          Несколько счетов
        </button>
      </div>
      <p className="muted small">
        «Один баланс» — все деньги в одном месте. «Несколько счетов» — например, карта, наличные и вклад отдельно.
      </p>

      {mode === 'single' && (
        <section className="card stack">
          <h2>Сколько денег сейчас</h2>
          <div className="row">
            <div className="grow">
              <label htmlFor="amount">Сумма</label>
              <input id="amount" className="field" inputMode="decimal" placeholder="0" value={rows[0].amount} onChange={(e) => patch(0, { amount: e.target.value })} />
            </div>
            <div className="w-cur">
              <label htmlFor="currency">Валюта</label>
              <CurrencySelect id="currency" value={rows[0].currency} onChange={(v) => patch(0, { currency: v })} />
            </div>
          </div>
        </section>
      )}

      {mode === 'multi' && (
        <section className="stack">
          {rows.map((r, i) => (
            <div className="card stack" key={i}>
              <label htmlFor={`name-${i}`}>{`Название счёта ${i + 1}`}</label>
              <input id={`name-${i}`} className="field" placeholder="Например: Карта" value={r.name} onChange={(e) => patch(i, { name: e.target.value })} />
              <div className="row">
                <div className="grow">
                  <label htmlFor={`amount-${i}`}>{`Сумма ${i + 1}`}</label>
                  <input id={`amount-${i}`} className="field" inputMode="decimal" placeholder="0" value={r.amount} onChange={(e) => patch(i, { amount: e.target.value })} />
                </div>
                <div className="w-cur">
                  <label htmlFor={`currency-${i}`}>{`Валюта ${i + 1}`}</label>
                  <CurrencySelect id={`currency-${i}`} value={r.currency} onChange={(v) => patch(i, { currency: v })} />
                </div>
              </div>
              {rows.length > 1 && (
                <button type="button" className="btn btn-link" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
                  Убрать счёт
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, newRow()])}>
            Добавить счёт
          </button>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {mode && (
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={finish}>
          Готово
        </button>
      )}
    </main>
  )
}
