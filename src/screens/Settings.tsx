import { useId, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { balances } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { round2 } from '@shared/fx.ts'
import { money } from '@shared/format.ts'
import type { Account, Category, Settings as SettingsRow, Transaction } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { csvFileName, downloadCsv, toCsv } from '../export.ts'
import { parseAmount } from '../lib/amount.ts'

const SAVE_FAILED = 'Не удалось сохранить'
const RECONCILE_NOTE = 'Сверка'
const CURRENCY_CODE = /^[A-Z]{3}$/
const DEFAULT_ICON = '🏷️'

/** Runs a save: `busy` while it works, `error` («Не удалось сохранить») when it throws. Resolves to success. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setError('')
    try {
      await fn()
      return true
    } catch {
      setError(SAVE_FAILED)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

const byName = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort
const nextSort = (rows: { sort: number }[]) => rows.reduce((max, r) => Math.max(max, r.sort), -1) + 1

/* ---------- accounts mode ---------- */

function ModeSection({ settings }: { settings: SettingsRow }) {
  const { repo } = useApp()
  const { busy, error, run } = useAction()
  const set = (accounts_mode: SettingsRow['accounts_mode']) =>
    run(async () => {
      await repo.put<SettingsRow>('settings', { id: settings.id, accounts_mode })
    })

  return (
    <Section title="Счета">
      <div className="choice" role="group" aria-label="Режим счетов">
        {(
          [
            ['single', 'Один счёт'],
            ['multi', 'Несколько счетов'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            className={`btn choice-btn${settings.accounts_mode === mode ? ' active' : ''}`}
            aria-pressed={settings.accounts_mode === mode}
            disabled={busy}
            onClick={() => void set(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">Переключение не удаляет счета и записи</p>
      <ErrorLine>{error}</ErrorLine>
    </Section>
  )
}

/* ---------- status ---------- */

function StatusSection({ settings }: { settings: SettingsRow }) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [next, setNext] = useState(settings.next_contract_date ?? '')
  const [lag, setLag] = useState(String(settings.salary_lag_days))
  const [start, setStart] = useState(settings.contract_start_date ?? '')
  const [end, setEnd] = useState(settings.contract_end_date ?? '')
  const home = settings.status === 'home'

  const setStatus = (status: SettingsRow['status']) =>
    run(async () => {
      await repo.put<SettingsRow>('settings', { id: settings.id, status })
    })

  async function saveDates() {
    if (home) {
      if (!/^\d+$/.test(lag.trim())) return setError('Введите число дней')
      await run(async () => {
        await repo.put<SettingsRow>('settings', {
          id: settings.id,
          next_contract_date: next || null,
          salary_lag_days: Number(lag.trim()),
        })
      })
    } else {
      if (start && end && end < start) return setError('Конец контракта раньше начала')
      await run(async () => {
        await repo.put<SettingsRow>('settings', {
          id: settings.id,
          contract_start_date: start || null,
          contract_end_date: end || null,
        })
      })
    }
  }

  return (
    <Section title="Статус">
      <div className="choice" role="group" aria-label="Статус">
        {(
          [
            ['home', 'Дома'],
            ['contract', 'В рейсе'],
          ] as const
        ).map(([status, label]) => (
          <button
            key={status}
            type="button"
            className={`btn choice-btn${settings.status === status ? ' active' : ''}`}
            aria-pressed={settings.status === status}
            disabled={busy}
            onClick={() => void setStatus(status)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void saveDates()
        }}
      >
        {home ? (
          <div className="row">
            <div className="grow">
              <label htmlFor="st-next">Следующий контракт</label>
              <input id="st-next" className="field" type="date" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="st-lag">Задержка зарплаты, дней</label>
              <input
                id="st-lag"
                className="field"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={lag}
                onChange={(e) => setLag(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="row">
            <div className="grow">
              <label htmlFor="st-start">Начало контракта</label>
              <input id="st-start" className="field" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="grow">
              <label htmlFor="st-end">Конец контракта</label>
              <input id="st-end" className="field" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
        )}
        <ErrorLine>{error}</ErrorLine>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Сохранить даты
        </button>
      </form>
    </Section>
  )
}

/* ---------- currencies ---------- */

function CurrenciesSection({ settings }: { settings: SettingsRow }) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [code, setCode] = useState('')

  const saveCurrencies = (currencies: string[]) =>
    run(async () => {
      await repo.put<SettingsRow>('settings', { id: settings.id, currencies })
    })

  async function add() {
    const value = code.trim().toUpperCase()
    if (!CURRENCY_CODE.test(value)) return setError('Код валюты — 3 латинские буквы')
    if (settings.currencies.includes(value)) return setError('Такая валюта уже есть')
    if (await saveCurrencies([...settings.currencies, value])) setCode('')
  }

  return (
    <Section title="Валюты">
      <ul className="set-list">
        {settings.currencies.map((c) => {
          const locked = c === settings.base_currency || c === settings.default_currency
          return (
            <li key={c} className="set-row">
              <span className="set-name">
                {c}
                {c === settings.base_currency && <span className="muted small">{' · базовая'}</span>}
              </span>
              {!locked && (
                <button
                  type="button"
                  className="btn btn-link"
                  aria-label={`Убрать валюту ${c}`}
                  disabled={busy}
                  onClick={() => void saveCurrencies(settings.currencies.filter((x) => x !== c))}
                >
                  Убрать
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <div>
        <label htmlFor="cur-default">Валюта по умолчанию</label>
        <select
          id="cur-default"
          className="field"
          value={settings.default_currency}
          disabled={busy}
          onChange={(e) =>
            void run(async () => {
              await repo.put<SettingsRow>('settings', { id: settings.id, default_currency: e.target.value })
            })
          }
        >
          {settings.currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div className="row">
          <div className="grow">
            <label htmlFor="cur-new">Новая валюта</label>
            <input
              id="cur-new"
              className="field"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={3}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={busy}>
            Добавить валюту
          </button>
        </div>
        <p className="muted small">Курс берётся у НБУ — валюта должна быть в его списке</p>
        <ErrorLine>{error}</ErrorLine>
      </form>
    </Section>
  )
}

/* ---------- reconciliation («Сверка») ---------- */

function ReconcileRow({
  label,
  inputLabel,
  button,
  current,
  currency,
  accountId,
  today,
}: {
  label: string
  inputLabel: string
  button: string
  current: number
  currency: string
  accountId: string | undefined
  today: string
}) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const inputId = useId()
  const [real, setReal] = useState('')
  const [note, setNote] = useState('')

  async function submit() {
    setNote('')
    const value = parseAmount(real)
    if (real.trim() === '' || !Number.isFinite(value)) return setError('Введите сумму')
    if (!accountId) return setError('Нет счёта для сверки')
    const diff = round2(value - current)
    if (diff === 0) {
      setError('')
      return setNote('Баланс совпадает')
    }
    const saved = await run(async () => {
      await repo.addTransaction({
        kind: 'adjustment',
        amount: diff,
        currency,
        account_id: accountId,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: today,
        note: RECONCILE_NOTE,
        source: 'app',
      })
    })
    if (saved) {
      setReal('')
      setNote(`Корректировка ${money(diff, currency)}`)
    }
  }

  return (
    <form
      className="stack recon-row"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="set-row">
        <span className="set-name">{label}</span>
        <span className={`balance${current < 0 ? ' neg' : ''}`}>{money(current, currency)}</span>
      </div>
      <div className="row">
        <div className="grow">
          <label htmlFor={inputId}>{inputLabel}</label>
          <input
            id={inputId}
            className="field"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={real}
            onChange={(e) => setReal(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {button}
        </button>
      </div>
      <ErrorLine>{error}</ErrorLine>
      {note && <p className="muted small">{note}</p>}
    </form>
  )
}

function ReconcileSection({
  settings,
  accounts,
  txs,
  today,
}: {
  settings: SettingsRow
  accounts: Account[]
  txs: Transaction[]
  today: string
}) {
  const multi = settings.accounts_mode === 'multi'
  const active = accounts.filter((a) => !a.archived).sort(byName)
  const defaultAccount = active.find((a) => a.is_default) ?? active[0]
  const currenciesOf = (bal: Record<string, number>) => [
    ...settings.currencies,
    ...Object.keys(bal).filter((c) => bal[c] !== 0 && !settings.currencies.includes(c)),
  ]

  return (
    <Section title="Сверка">
      <p className="muted small">Введите реальный остаток — разница запишется как корректировка</p>
      {multi
        ? active.flatMap((a) => {
            const bal = balances(txs, a.id)
            return currenciesOf(bal).map((c) => (
              <ReconcileRow
                key={`${a.id}:${c}`}
                label={`${a.name} · ${c}`}
                inputLabel={`Реальный остаток ${a.name} ${c}`}
                button={`Сверить ${a.name} ${c}`}
                current={bal[c] ?? 0}
                currency={c}
                accountId={a.id}
                today={today}
              />
            ))
          })
        : (() => {
            const bal = balances(txs)
            return currenciesOf(bal).map((c) => (
              <ReconcileRow
                key={c}
                label={c}
                inputLabel={`Реальный остаток ${c}`}
                button={`Сверить ${c}`}
                current={bal[c] ?? 0}
                currency={c}
                accountId={defaultAccount?.id}
                today={today}
              />
            ))
          })()}
    </Section>
  )
}

/* ---------- categories ---------- */

function CategoryForm({
  category,
  categories,
  onClose,
}: {
  category: Category | null
  categories: Category[]
  onClose(): void
}) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<Category['kind']>(category?.kind ?? 'expense')
  const [icon, setIcon] = useState(category?.icon ?? '')

  async function save() {
    if (!name.trim()) return setError('Введите название')
    const saved = await run(async () => {
      const common = { name: name.trim(), icon: icon.trim() || DEFAULT_ICON }
      if (category) {
        await repo.put<Category>('categories', { id: category.id, ...common })
      } else {
        await repo.put<Category>('categories', {
          ...common,
          kind,
          keywords: [],
          archived: false,
          sort: nextSort(categories),
        })
      }
    })
    if (saved) onClose()
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>{category ? 'Категория' : 'Новая категория'}</h2>
      <div>
        <label htmlFor="cat-name">Название категории</label>
        <input id="cat-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {!category && (
        <div>
          <label htmlFor="cat-kind">Тип</label>
          <select id="cat-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value as Category['kind'])}>
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
        </div>
      )}
      <div>
        <label htmlFor="cat-icon">Иконка</label>
        <input
          id="cat-icon"
          className="field"
          type="text"
          autoComplete="off"
          placeholder={DEFAULT_ICON}
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
        />
      </div>
      <ErrorLine>{error}</ErrorLine>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить категорию
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

type CategoryEditing = { id: string } | 'new' | null

function CategoriesSection({ categories }: { categories: Category[] }) {
  const { repo } = useApp()
  const { busy, error, run } = useAction()
  const [editing, setEditing] = useState<CategoryEditing>(null)

  if (editing) {
    const category = editing === 'new' ? null : (categories.find((c) => c.id === editing.id) ?? null)
    return <CategoryForm category={category} categories={categories} onClose={() => setEditing(null)} />
  }

  const setArchived = (c: Category, archived: boolean) =>
    run(async () => {
      await repo.put<Category>('categories', { id: c.id, archived })
    })

  return (
    <Section title="Категории">
      {(
        [
          ['expense', 'Расходы'],
          ['income', 'Доходы'],
        ] as const
      ).map(([kind, title]) => (
        <div key={kind}>
          <h3 className="label">{title}</h3>
          <ul className="set-list">
            {categories
              .filter((c) => c.kind === kind)
              .sort(byName)
              .map((c) => (
                <li key={c.id} className={`set-row${c.archived ? ' archived' : ''}`}>
                  <span className="set-icon" aria-hidden="true">
                    {c.icon}
                  </span>
                  <span className="set-name">
                    {c.name}
                    {c.archived && <span className="muted small">{' · в архиве'}</span>}
                  </span>
                  <button
                    type="button"
                    className="btn btn-link"
                    aria-label={`Изменить категорию ${c.name}`}
                    disabled={busy}
                    onClick={() => setEditing({ id: c.id })}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="btn btn-link"
                    aria-label={`${c.archived ? 'Вернуть' : 'Архивировать'} категорию ${c.name}`}
                    disabled={busy}
                    onClick={() => void setArchived(c, !c.archived)}
                  >
                    {c.archived ? 'Вернуть' : 'В архив'}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <ErrorLine>{error}</ErrorLine>
      <button type="button" className="btn" onClick={() => setEditing('new')}>
        + Категория
      </button>
    </Section>
  )
}

/* ---------- accounts management ---------- */

function AccountForm({ account, onClose }: { account: Account; onClose(): void }) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [name, setName] = useState(account.name)
  const [aliases, setAliases] = useState(account.aliases.join(', '))

  async function save() {
    if (!name.trim()) return setError('Введите название')
    const saved = await run(async () => {
      await repo.put<Account>('accounts', {
        id: account.id,
        name: name.trim(),
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
      })
    })
    if (saved) onClose()
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>Счёт</h2>
      <div>
        <label htmlFor="acc-edit-name">Название счёта</label>
        <input id="acc-edit-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="acc-edit-aliases">Псевдонимы (через запятую)</label>
        <input
          id="acc-edit-aliases"
          className="field"
          type="text"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
      </div>
      <ErrorLine>{error}</ErrorLine>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить счёт
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

function AccountsSection({ accounts }: { accounts: Account[] }) {
  const { repo } = useApp()
  const { busy, error, run } = useAction()
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = accounts.find((a) => a.id === editingId)
  if (editing) return <AccountForm account={editing} onClose={() => setEditingId(null)} />

  const activeCount = accounts.filter((a) => !a.archived).length
  const setArchived = (a: Account, archived: boolean) =>
    run(async () => {
      await repo.put<Account>('accounts', { id: a.id, archived })
    })

  return (
    <Section title="Управление счетами">
      <ul className="set-list">
        {[...accounts].sort(byName).map((a) => {
          // the default account stays, and so does the last active one
          const cannotArchive = !a.archived && (a.is_default || activeCount <= 1)
          return (
            <li key={a.id} className={`set-row${a.archived ? ' archived' : ''}`}>
              <span className="set-name">
                {a.name}
                {a.is_default && <span className="muted small">{' · основной'}</span>}
                {a.archived && <span className="muted small">{' · в архиве'}</span>}
                {a.aliases.length > 0 && <span className="muted small set-sub">{a.aliases.join(', ')}</span>}
              </span>
              <button
                type="button"
                className="btn btn-link"
                aria-label={`Изменить счёт ${a.name}`}
                disabled={busy}
                onClick={() => setEditingId(a.id)}
              >
                Изменить
              </button>
              <button
                type="button"
                className="btn btn-link"
                aria-label={`${a.archived ? 'Вернуть' : 'Архивировать'} счёт ${a.name}`}
                disabled={busy || cannotArchive}
                onClick={() => void setArchived(a, !a.archived)}
              >
                {a.archived ? 'Вернуть' : 'В архив'}
              </button>
            </li>
          )
        })}
      </ul>
      <ErrorLine>{error}</ErrorLine>
    </Section>
  )
}

/* ---------- export ---------- */

function ExportSection({ today, partnerName }: { today: string; partnerName: string | null }) {
  const { db } = useApp()
  const { busy, error, run } = useAction()

  const exportCsv = () =>
    run(async () => {
      const [txs, categories, accounts] = await Promise.all([
        db.transactions.filter(alive).toArray(),
        db.categories.toArray(),
        db.accounts.toArray(),
      ])
      txs.sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
      downloadCsv(csvFileName(today), toCsv(txs, categories, accounts, partnerName))
    })

  return (
    <Section title="Экспорт">
      <p className="muted small">Все записи одним файлом для Excel</p>
      <ErrorLine>{error}</ErrorLine>
      <button type="button" className="btn" disabled={busy} onClick={() => void exportCsv()}>
        Экспорт CSV
      </button>
    </Section>
  )
}

/* ---------- screen ---------- */

export function Settings({ onSignOut }: { onSignOut(): void }) {
  const { db, now } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, accounts, categories, txs] = await Promise.all([
      db.settings.filter(alive).first(),
      db.accounts.filter(alive).toArray(),
      db.categories.filter(alive).toArray(),
      db.transactions.filter(alive).toArray(),
    ])
    return { settings, accounts, categories, txs }
  }, [db])

  if (!data) return <p className="muted pad">Загрузка…</p>
  const { settings, accounts, categories, txs } = data
  if (!settings) return <p className="muted pad">Сначала завершите настройку</p>
  const today = localDate(now(), settings.timezone)

  return (
    <div className="stack">
      <h2>Настройки</h2>
      <ModeSection settings={settings} />
      <StatusSection key={settings.id} settings={settings} />
      <CurrenciesSection settings={settings} />
      <ReconcileSection settings={settings} accounts={accounts} txs={txs} today={today} />
      <CategoriesSection categories={categories} />
      {settings.accounts_mode === 'multi' && <AccountsSection accounts={accounts} />}
      <ExportSection today={today} partnerName={settings.partner_name} />
      <button type="button" className="btn btn-danger btn-block" onClick={onSignOut}>
        Выйти
      </button>
    </div>
  )
}
