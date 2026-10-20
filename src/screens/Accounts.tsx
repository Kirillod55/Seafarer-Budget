import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { balanceUsd, balances } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import type { Account, Settings } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'

type Panel = 'transfer' | 'exchange' | 'account' | null

function CurrencySelect({
  id,
  value,
  currencies,
  onChange,
  label = 'Валюта',
}: {
  id: string
  value: string
  currencies: string[]
  onChange(v: string): void
  label?: string
}) {
  return (
    <div className="w-cur">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {currencies.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  )
}

function AmountInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange(v: string): void }) {
  return (
    <div className="grow">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="field"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function FormButtons({ busy, submit, onCancel }: { busy: boolean; submit: string; onCancel(): void }) {
  return (
    <div className="row">
      <button type="submit" className="btn btn-primary grow" disabled={busy}>
        {submit}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>
        Отмена
      </button>
    </div>
  )
}

function TransferForm({
  accounts,
  settings,
  today,
  onClose,
}: {
  accounts: Account[]
  settings: Settings
  today: string
  onClose(): void
}) {
  const { repo } = useApp()
  const first = accounts.find((a) => a.is_default) ?? accounts[0]
  const [from, setFrom] = useState(first?.id ?? '')
  const [to, setTo] = useState(accounts.find((a) => a.id !== first?.id)?.id ?? '')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(settings.default_currency)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    if (!from || !to || from === to) return setError('Выберите разные счета')
    setBusy(true)
    try {
      await repo.addTransaction({
        kind: 'transfer',
        amount: value,
        currency,
        account_id: from,
        to_account_id: to,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: today,
        note: '',
        source: 'app',
      })
      onClose()
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={(e) => set(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>Перевод</h2>
      {select('tr-from', 'Со счёта', from, setFrom)}
      {select('tr-to', 'На счёт', to, setTo)}
      <div className="row">
        <AmountInput id="tr-amount" label="Сумма" value={amount} onChange={setAmount} />
        <CurrencySelect id="tr-currency" value={currency} currencies={settings.currencies} onChange={setCurrency} />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <FormButtons busy={busy} submit="Перевести" onCancel={onClose} />
    </form>
  )
}

function ExchangeForm({
  accounts,
  multi,
  settings,
  today,
  onClose,
}: {
  accounts: Account[]
  multi: boolean
  settings: Settings
  today: string
  onClose(): void
}) {
  const { repo } = useApp()
  const [accountId, setAccountId] = useState((accounts.find((a) => a.is_default) ?? accounts[0])?.id ?? '')
  const [fromAmount, setFromAmount] = useState('')
  const [fromCurrency, setFromCurrency] = useState(settings.default_currency)
  const [toAmount, setToAmount] = useState('')
  const [toCurrency, setToCurrency] = useState(
    settings.currencies.find((c) => c !== settings.default_currency) ?? settings.default_currency,
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const out = parseAmount(fromAmount)
    const inn = parseAmount(toAmount)
    if (!(out > 0) || !(inn > 0)) return setError('Введите сумму')
    if (fromCurrency === toCurrency) return setError('Выберите разные валюты')
    if (!accountId) return setError('Выберите счёт')
    setBusy(true)
    try {
      await repo.addTransaction({
        kind: 'exchange',
        amount: out,
        currency: fromCurrency,
        account_id: accountId,
        to_account_id: accountId, // the money stays on the same account
        to_amount: inn,
        to_currency: toCurrency,
        category_id: null,
        date: today,
        note: '',
        source: 'app',
      })
      onClose()
    } catch {
      setError('Не удалось сохранить')
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
      <h2>Обмен валюты</h2>
      {multi && (
        <div>
          <label htmlFor="ex-account">Счёт</label>
          <select id="ex-account" className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="row">
        <AmountInput id="ex-from-amount" label="Сумма списания" value={fromAmount} onChange={setFromAmount} />
        <CurrencySelect
          id="ex-from-currency"
          label="Валюта списания"
          value={fromCurrency}
          currencies={settings.currencies}
          onChange={setFromCurrency}
        />
      </div>
      <div className="row">
        <AmountInput id="ex-to-amount" label="Сумма зачисления" value={toAmount} onChange={setToAmount} />
        <CurrencySelect
          id="ex-to-currency"
          label="Валюта зачисления"
          value={toCurrency}
          currencies={settings.currencies}
          onChange={setToCurrency}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <FormButtons busy={busy} submit="Обменять" onCancel={onClose} />
    </form>
  )
}

function AccountForm({ accounts, onClose }: { accounts: Account[]; onClose(): void }) {
  const { repo } = useApp()
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!name.trim()) return setError('Введите название')
    setBusy(true)
    try {
      await repo.put<Account>('accounts', {
        name: name.trim(),
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        is_default: false,
        archived: false,
        sort: accounts.reduce((max, a) => Math.max(max, a.sort), -1) + 1,
      })
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
      <h2>Новый счёт</h2>
      <div>
        <label htmlFor="acc-name">Название</label>
        <input id="acc-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="acc-aliases">Псевдонимы (через запятую)</label>
        <input id="acc-aliases" className="field" type="text" value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </div>
      <FormButtons busy={busy} submit="Сохранить" onCancel={onClose} />
    </form>
  )
}

export function Accounts() {
  const { db, now } = useApp()
  const [panel, setPanel] = useState<Panel>(null)
  const data = useLiveQuery(async () => {
    const [settings, accounts, txs, rates] = await Promise.all([
      db.settings.filter((s) => !s.deleted).first(),
      db.accounts.filter((a) => !a.deleted && !a.archived).sortBy('sort'),
      db.transactions.filter((t) => !t.deleted).toArray(),
      db.fx_rates.toArray(),
    ])
    return { settings, accounts, txs, rates }
  }, [db])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, accounts, txs, rates } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>
  const multi = settings.accounts_mode === 'multi'
  const today = localDate(now(), settings.timezone)
  const close = () => setPanel(null)

  return (
    <div className="stack">
      <h2>Счета</h2>

      {panel === 'transfer' ? (
        <TransferForm accounts={accounts} settings={settings} today={today} onClose={close} />
      ) : panel === 'exchange' ? (
        <ExchangeForm accounts={accounts} multi={multi} settings={settings} today={today} onClose={close} />
      ) : panel === 'account' ? (
        <AccountForm accounts={accounts} onClose={close} />
      ) : (
        <div className="row">
          {multi &&
            (accounts.length >= 2 ? (
              <button type="button" className="btn grow" onClick={() => setPanel('transfer')}>
                Перевод
              </button>
            ) : (
              <p className="muted small grow">Для перевода нужно два счёта</p>
            ))}
          <button type="button" className="btn grow" onClick={() => setPanel('exchange')}>
            Обмен валюты
          </button>
          {multi && (
            <button type="button" className="btn grow" onClick={() => setPanel('account')}>
              + Счёт
            </button>
          )}
        </div>
      )}

      {multi ? (
        accounts.map((a) => {
          const bal = balances(txs, a.id)
          const shown = Object.entries(bal).filter(([, v]) => v !== 0)
          return (
            <section key={a.id} className="card stack" aria-label={a.name}>
              <h2>{a.name}</h2>
              {shown.length === 0 ? (
                <p className="muted small">Баланс пуст</p>
              ) : (
                <>
                  <p className="balances">
                    {shown.map(([cur, v]) => (
                      <span key={cur} className={`balance${v < 0 ? ' neg' : ''}`}>
                        {money(v, cur)}
                      </span>
                    ))}
                  </p>
                  <p className="muted small">{`≈ ${money(balanceUsd(bal, rates, today), 'USD')}`}</p>
                </>
              )}
            </section>
          )
        })
      ) : (
        <p className="muted small">Несколько счетов включаются в настройках</p>
      )}
    </div>
  )
}
