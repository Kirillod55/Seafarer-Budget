import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { activeBalances, balanceUsd, balances, reservingGoalMoves, reservedUsd } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Account, Category, FxRate, Settings, Transaction } from '@shared/types.ts'
import { DayGroups } from '../components/DayGroups.tsx'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { curOptions } from '../ui/currencies.ts'
import { Archive, CreditCard, Pencil, Plus, Wallet } from '../ui/icons.ts'
import { onEnter as enterRuns } from '../ui/keys.ts'
import { prefersReducedMotion } from '../ui/motion.ts'
import { Picker } from '../ui/Picker.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Sheet, type SheetHandle } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'
import { useFlip } from '../ui/useFlip.ts'
import { useDayTick } from '../ui/useDayTick.ts'
import { useRecordSheet } from './RecordSheet.tsx'
import './record.css'
import './goals.css'
import './accounts.css'

const FAILED = 'Не получилось — попробуй ещё раз'
const RECONCILE_NOTE = 'Сверка'
/** card colours in turn (tokens --acc-0…5) */
const ACC_COLORS = 6
const accColor = (index: number) => `var(--acc-${index % ACC_COLORS})`
/** rows in «Последние операции», and how many more each «Показать ещё» adds */
const RECENT_PAGE = 20
/** the «Все» item of the filter */
const ALL = 'all'
/** vDesk in desk.css: the rows are built after the page has opened, so that building them never holds its start */
const RECENT_AFTER_MS = 300
const usdWhole = (n: number) => money(n, 'USD', { whole: true })

type Op = 'transfer' | 'exchange' | 'reconcile'
/** The dialog: «Новый счёт» or «Счёт» (edit). */
type Panel = { kind: 'new' } | { kind: 'edit'; id: string } | null

/** «карта, visa ,» → ['карта', 'visa'] */
const splitAliases = (text: string) =>
  text
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

/** Why an account cannot be deleted, as the bot says it: the main one, or money still on it. null: it can. */
function deleteBlock(a: Account, txs: Transaction[]): string | null {
  if (a.is_default) return 'Основной счёт удалить нельзя.'
  const left = Object.entries(balances(txs, a.id)).filter(([, v]) => Math.abs(v) >= 0.005)
  if (!left.length) return null
  return `На счёте ${left.map(([c, v]) => money(v, c)).join(' + ')}. Удалить можно только пустой счёт: сначала переведи остаток.`
}

/* ---------- the account cards ---------- */

function AccountCard({
  flipKey,
  name,
  bal,
  usd,
  index,
  single,
  isDefault,
  onEdit,
  onArchive,
}: {
  /** the account's id (a rename keeps the block), or 'single' */
  flipKey: string
  name: string
  bal: Record<string, number>
  usd: number
  index: number
  single: boolean
  isDefault: boolean
  onEdit?(): void
  onArchive?(): void
}) {
  const Icon = single ? Wallet : CreditCard
  // whole amounts, as in the prototype: a currency that rounds to 0 is left out
  const shown = Object.entries(bal).filter(([, v]) => Math.round(Math.abs(v)) !== 0)
  return (
    <section
      className="acard"
      style={{ '--c': accColor(index) } as CSSProperties}
      aria-label={name}
      data-flip-key={`acc-${flipKey}`}
    >
      <div className="acard-top">
        <span className="acard-ic" aria-hidden="true">
          <Icon strokeWidth={2} />
        </span>
        <span className="acard-name">{name}</span>
        {isDefault && !single && <span className="acard-badge">Основной</span>}
      </div>
      <div className="acard-bal num">{`≈ ${usdWhole(usd)}`}</div>
      <div className={`acard-cur${onEdit && onArchive ? ' two' : onEdit ? ' one' : ''}`}>
        {shown.length ? (
          shown.map(([cur, v]) => (
            <span key={cur} className="num">
              {money(v, cur, { whole: true })}
            </span>
          ))
        ) : (
          <span>Пусто</span>
        )}
      </div>
      {(onEdit || onArchive) && (
        <span className="acard-acts">
          {onEdit && (
            <button type="button" className="acard-btn" aria-label={`Изменить «${name}»`} title="Изменить" onClick={onEdit}>
              <Pencil strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          {onArchive && (
            <button
              type="button"
              className="acard-btn"
              aria-label={`Убрать «${name}» в архив`}
              title="Убрать в архив"
              onClick={onArchive}
            >
              <Archive strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
    </section>
  )
}

/**
 * «Новый счёт» / «Счёт» (the 1.0 «Управление счетами» lives here now): the name and the aliases the bot knows the
 * account by («кофе 80 прокредит», spec §5). An empty name and a repeated one (any case, archived ones too) are refused.
 * An empty account that is not the main one can be deleted here, after a second press: final, as in the bot.
 */
function AccountForm({ account, accounts, blocked, onClose }: {
  account?: Account
  accounts: Account[]
  /** an edited account that cannot be deleted: why */
  blocked?: string | null
  onClose(): void
}) {
  const { repo } = useApp()
  const toast = useToast()
  const sheet = useRef<SheetHandle>(null)
  const [name, setName] = useState(account?.name ?? '')
  const [aliases, setAliases] = useState(account?.aliases.join(', ') ?? '')
  const [error, setError] = useState('')
  const [sure, setSure] = useState(false)

  /** final: the repo checks again when it writes (a record may have come in meanwhile) */
  const remove = (id: string) =>
    sheet.current?.close(() => {
      repo.removeEmptyAccount(id, true).then(
        (done) => toast(done ? 'Счёт удалён' : 'Не удалён: на счёте появились записи'),
        () => toast(FAILED),
      )
    })

  /** false keeps the dialog open */
  async function save(): Promise<boolean> {
    const n = name.trim()
    if (!n) {
      setError('Введите название')
      return false
    }
    const taken = accounts.some((a) => a.id !== account?.id && a.name.trim().toLowerCase() === n.toLowerCase())
    if (taken) {
      setError('Такой счёт уже есть')
      return false
    }
    try {
      if (account) await repo.put<Account>('accounts', { id: account.id, name: n, aliases: splitAliases(aliases) })
      else
        await repo.put<Account>('accounts', {
          name: n,
          aliases: splitAliases(aliases),
          is_default: false,
          archived: false,
          sort: accounts.reduce((max, a) => Math.max(max, a.sort), -1) + 1,
        })
      return true
    } catch {
      toast(FAILED)
      return false
    }
  }

  const submit = enterRuns(() => sheet.current?.submit())
  return (
    <Sheet ref={sheet} onClose={onClose} title={account ? 'Счёт' : 'Новый счёт'} trailing={{ label: account ? 'Сохранить' : 'Создать', run: save }}>
      <div className="rec acform">
        <div className="fld">
          <label htmlFor="acc-name">Название</label>
          <input
            id="acc-name"
            className="inp"
            type="text"
            placeholder="Например, Наличные"
            autoComplete="off"
            maxLength={40}
            aria-invalid={!!error}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (error) setError('')
            }}
            onKeyDown={submit}
          />
        </div>
        <div className="fld">
          <label htmlFor="acc-aliases">Псевдонимы для бота</label>
          <input
            id="acc-aliases"
            className="inp"
            type="text"
            placeholder="Через запятую: нал, кэш"
            autoComplete="off"
            aria-describedby="acc-aliases-hint"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            onKeyDown={submit}
          />
          <p id="acc-aliases-hint" className="label">
            Бот узнаёт счёт по названию и этим словам: «кофе 80 нал».
          </p>
        </div>
        {error && (
          <p className="gerr" role="alert">
            {error}
          </p>
        )}
        {account && (
          <div className="acdel">
            {blocked ? (
              <p className="label">{blocked}</p>
            ) : sure ? (
              <>
                <p className="label">{`Удалить счёт «${account.name}»? Старые записи останутся, вернуть счёт нельзя.`}</p>
                <div className="gacts">
                  <button type="button" className="btn-gray danger" onClick={() => remove(account.id)}>
                    Да, удалить
                  </button>
                  <button type="button" className="btn-gray" onClick={() => setSure(false)}>
                    Нет
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="btn-gray danger" onClick={() => setSure(true)}>
                Удалить счёт
              </button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}

/* ---------- «Операции» ---------- */

interface OpsProps {
  settings: Settings
  /** active accounts, the default first */
  accounts: Account[]
  txs: Transaction[]
  rates: FxRate[]
  today: string
  multi: boolean
  /** every currency on hand (archived accounts left out): what «Один баланс» reconciles against */
  onHand: Record<string, number>
}

function useSubmit() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

/** The currencies of the settings, plus the one chosen (it may come from elsewhere). */
const currencyOptions = (settings: Settings, ...chosen: string[]) => curOptions([...settings.currencies, ...chosen])

function ErrorLine({ text }: { text: string }) {
  return text ? (
    <p className="gerr" role="alert">
      {text}
    </p>
  ) : null
}

function AmountField({ id, label, value, placeholder, onChange, onEnter, invalid }: {
  id: string
  label: string
  value: string
  placeholder: string
  onChange(v: string): void
  onEnter(): void
  invalid?: boolean
}) {
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp num"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        aria-invalid={invalid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={enterRuns(onEnter)}
      />
    </div>
  )
}

/**
 * «Перевод»: «Откуда» / «Куда» as glass menus with each account's ≈ $ (choosing in one field the account that stands
 * in the other swaps them — spec §6), the amount and the currency. One active account: a hint instead (spec §4).
 */
function TransferForm({ settings, accounts, txs, rates, today }: OpsProps) {
  const { repo } = useApp()
  const { busy, run } = useSubmit()
  const [from, setFrom] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState(accounts[1]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(settings.default_currency)
  const [error, setError] = useState('')

  if (accounts.length < 2) return <p className="small ophint">Для перевода нужно хотя бы два счёта. Убранные счета — в «Архиве».</p>

  // an account archived meanwhile falls back to the first free one
  const fromId = accounts.some((a) => a.id === from) ? from : accounts[0].id
  const toId = accounts.some((a) => a.id === to) && to !== fromId ? to : accounts.find((a) => a.id !== fromId)!.id
  const options = accounts.map((a) => ({
    value: a.id,
    label: a.name,
    sub: `≈ ${usdWhole(balanceUsd(balances(txs, a.id), rates, today))}`,
  }))
  const chooseFrom = (v: string) => {
    if (v === toId) setTo(fromId)
    setFrom(v)
  }
  const chooseTo = (v: string) => {
    if (v === fromId) setFrom(toId)
    setTo(v)
  }

  const save = () =>
    run(async () => {
      const value = parseAmount(amount)
      if (!(value > 0)) return setError('Введите сумму')
      setError('')
      await repo.addTransaction({
        kind: 'transfer',
        amount: round2(value),
        currency,
        account_id: fromId,
        to_account_id: toId,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: today,
        note: '',
        source: 'app',
        author: 'owner',
        archived: false,
      })
      setAmount('')
    })

  return (
    <div className="rec opform">
      <div className="fld">
        <label htmlFor="tr-from">Откуда</label>
        <Picker id="tr-from" label="Откуда" value={fromId} options={options} onChange={chooseFrom} />
      </div>
      <div className="fld">
        <label htmlFor="tr-to">Куда</label>
        <Picker id="tr-to" label="Куда" value={toId} options={options} onChange={chooseTo} />
      </div>
      <div className="grid2">
        <AmountField id="tr-amount" label="Сумма" placeholder="200" value={amount} invalid={!!error} onChange={setAmount} onEnter={() => void save()} />
        <div className="fld">
          <label htmlFor="tr-cur">Валюта</label>
          <Picker id="tr-cur" label="Валюта" kind="currency" value={currency} options={currencyOptions(settings, currency)} onChange={setCurrency} />
        </div>
      </div>
      {error ? <ErrorLine text={error} /> : <p className="label">{`Сейчас на счёте ≈ ${usdWhole(balanceUsd(balances(txs, fromId), rates, today))}`}</p>}
      <button type="button" className="btn-acc" disabled={busy} onClick={() => void save()}>
        Перевести
      </button>
    </div>
  )
}

/** «1 USD = 45.00 UAH · НБУ 45.03 · на 0.1% дешевле» (prototype x-rate), or the hint while a sum is missing. */
function rateLine(gave: number, got: number, gaveCur: string, gotCur: string, rates: FxRate[], today: string) {
  if (!(gave > 0) || !(got > 0) || gaveCur === gotCur) return null
  const mine = gave / got
  const a = usdRate(rates, gaveCur, today)
  const b = usdRate(rates, gotCur, today)
  const line = `1 ${gotCur} = `
  if (!a || !b) return { line, mine: `${mine.toFixed(2)} ${gaveCur}`, tail: '' }
  const nbu = b.rate / a.rate
  const d = (mine / nbu - 1) * 100
  const cmp = Math.abs(d) < 0.05 ? 'как у НБУ' : `на ${Math.abs(d).toFixed(1)}% ${d > 0 ? 'дороже' : 'дешевле'}`
  return { line, mine: `${mine.toFixed(2)} ${gaveCur}`, tail: ` · НБУ ${nbu.toFixed(2)} · ${cmp}` }
}

/** «Обмен»: gave / got with their currencies on one account (the default in «Один баланс»), the live rate line. */
function ExchangeForm({ settings, accounts, rates, today, multi }: OpsProps) {
  const { repo } = useApp()
  const { busy, run } = useSubmit()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [gave, setGave] = useState('')
  const [gaveCur, setGaveCur] = useState(settings.default_currency)
  const [got, setGot] = useState('')
  const [gotCur, setGotCur] = useState(
    settings.default_currency === 'USD' ? (settings.currencies.find((c) => c !== 'USD') ?? 'UAH') : 'USD',
  )
  const [error, setError] = useState('')
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
  const r = rateLine(parseAmount(gave), parseAmount(got), gaveCur, gotCur, rates, today)

  const save = () =>
    run(async () => {
      const out = parseAmount(gave)
      const inn = parseAmount(got)
      if (!(out > 0) || !(inn > 0)) return setError('Введите обе суммы')
      if (gaveCur === gotCur) return setError('Выберите разные валюты')
      if (!account) return setError('Нет счёта')
      setError('')
      await repo.addTransaction({
        kind: 'exchange',
        amount: round2(out),
        currency: gaveCur,
        account_id: account.id,
        to_account_id: account.id, // the money stays on the same account
        to_amount: round2(inn),
        to_currency: gotCur,
        category_id: null,
        date: today,
        note: '',
        source: 'app',
        author: 'owner',
        archived: false,
      })
      setGave('')
      setGot('')
    })

  return (
    <div className="rec opform">
      {multi && (
        <div className="fld">
          <label htmlFor="x-acc">Счёт</label>
          <Picker
            id="x-acc"
            label="Счёт"
            value={account?.id ?? ''}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
            onChange={setAccountId}
          />
        </div>
      )}
      <div className="grid2">
        <AmountField id="x-gave" label="Отдал" placeholder="4500" value={gave} onChange={setGave} onEnter={() => void save()} />
        <div className="fld">
          <label htmlFor="x-gave-cur">Валюта</label>
          <Picker
            id="x-gave-cur"
            label="Валюта, отдал"
            kind="currency"
            value={gaveCur}
            options={currencyOptions(settings, gaveCur)}
            onChange={setGaveCur}
          />
        </div>
      </div>
      <div className="grid2">
        <AmountField id="x-got" label="Получил" placeholder="100" value={got} onChange={setGot} onEnter={() => void save()} />
        <div className="fld">
          <label htmlFor="x-got-cur">Валюта</label>
          <Picker
            id="x-got-cur"
            label="Валюта, получил"
            kind="currency"
            value={gotCur}
            options={currencyOptions(settings, gotCur)}
            onChange={setGotCur}
          />
        </div>
      </div>
      {error ? (
        <ErrorLine text={error} />
      ) : (
        <p className="xrate" aria-live="polite">
          {r ? (
            <>
              {r.line}
              <b className="num">{r.mine}</b>
              {r.tail}
            </>
          ) : (
            'Курс появится, когда впишешь обе суммы'
          )}
        </p>
      )}
      <button type="button" className="btn-acc" disabled={busy} onClick={() => void save()}>
        Обменять
      </button>
    </div>
  )
}

/**
 * «Сверка»: the account (in «Несколько счетов»), how much there really is and the currency; the difference with what
 * is written goes in as an adjustment dated today (as «Ещё → Сверка»). In «Один баланс» it compares the whole balance
 * and writes to the default account.
 */
function ReconcileForm({ settings, accounts, txs, today, multi, onHand }: OpsProps) {
  const { repo } = useApp()
  const { busy, run } = useSubmit()
  const [accountId, setAccountId] = useState((accounts[1] ?? accounts[0])?.id ?? '')
  const [real, setReal] = useState('')
  const [currency, setCurrency] = useState(settings.default_currency)
  const [hint, setHint] = useState<{ text: string; err?: boolean } | null>(null)
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
  const current = (multi ? balances(txs, account?.id) : onHand)[currency] ?? 0

  const save = () =>
    run(async () => {
      const value = parseAmount(real)
      if (real.trim() === '' || !Number.isFinite(value)) return setHint({ text: 'Введите сумму', err: true })
      if (!account) return setHint({ text: 'Нет счёта для сверки', err: true })
      const diff = round2(value - current)
      if (diff === 0) return setHint({ text: 'Всё сходится, корректировка не нужна' })
      await repo.addTransaction({
        kind: 'adjustment',
        amount: diff,
        currency,
        account_id: account.id,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: today,
        note: RECONCILE_NOTE,
        source: 'app',
        author: 'owner',
        archived: false,
      })
      setReal('')
      setHint({ text: `Корректировка ${diff > 0 ? '+' : ''}${money(diff, currency)}` })
    })

  return (
    <div className="rec opform">
      {multi && (
        <div className="fld">
          <label htmlFor="rc-acc">Счёт</label>
          <Picker
            id="rc-acc"
            label="Счёт"
            value={account?.id ?? ''}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(v) => {
              setAccountId(v)
              setHint(null)
            }}
          />
        </div>
      )}
      <div className="grid2">
        <AmountField
          id="rc-real"
          label="Сколько на самом деле"
          placeholder={String(Math.round(current))}
          value={real}
          invalid={!!hint?.err}
          onChange={(v) => {
            setReal(v)
            if (hint) setHint(null)
          }}
          onEnter={() => void save()}
        />
        <div className="fld">
          <label htmlFor="rc-cur">Валюта</label>
          <Picker
            id="rc-cur"
            label="Валюта"
            kind="currency"
            value={currency}
            options={currencyOptions(settings, currency)}
            onChange={(v) => {
              setCurrency(v)
              setHint(null)
            }}
          />
        </div>
      </div>
      {hint ? (
        <p className={hint.err ? 'gerr' : 'label'} role={hint.err ? 'alert' : 'status'}>
          {hint.text}
        </p>
      ) : (
        <p className="label">{`Записано ${money(current, currency)}. Разницу внесу корректировкой.`}</p>
      )}
      <button type="button" className="btn-acc" disabled={busy} onClick={() => void save()}>
        Сверить
      </button>
    </div>
  )
}

const OPS: Record<Op, string> = { transfer: 'Перевод', exchange: 'Обмен', reconcile: 'Сверка' }

// memo: a tab switch re-renders «Операции» only, the forms and their balances stay as they are
const OP_FORMS = { transfer: memo(TransferForm), exchange: memo(ExchangeForm), reconcile: memo(ReconcileForm) }

/**
 * One card «Операции» with «Перевод · Обмен · Сверка» (spec §11; «Обмен · Сверка» in «Один баланс»). All the forms stay
 * mounted in one grid cell, so the card is as tall as the tallest one: a switch is a cross-fade only, nothing is laid
 * out or mounted, nothing on the page moves, and a half-typed sum survives it.
 */
function Operations(props: OpsProps) {
  const titleId = useId()
  const tabs: Op[] = props.multi ? ['transfer', 'exchange', 'reconcile'] : ['exchange', 'reconcile']
  const [chosen, setChosen] = useState<Op>(tabs[0])
  const op = tabs.includes(chosen) ? chosen : tabs[0]
  return (
    <section className="card gcard accops" data-flip-key="ops" aria-labelledby={titleId}>
      <h3 id={titleId}>Операции</h3>
      <Segmented<Op> label="Операция" options={tabs.map((v) => ({ value: v, label: OPS[v] }))} value={op} onChange={setChosen} />
      <div className="opstack">
        {tabs.map((t) => {
          const Form = OP_FORMS[t]
          return (
            <div key={t} className={`oppane${t === op ? ' on' : ''}`} inert={t !== op}>
              <Form {...props} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

interface RecentProps {
  txs: Transaction[]
  categories: Category[]
  /** archived ones too: their old records keep their names */
  accounts: Account[]
  partnerName: string | null
  today: string
}

/** The rows of one filter item: ALL, or one account with the transfers in and out of it. */
const RecentList = memo(function RecentList({ txs, categories, accounts, partnerName, today, id, tagColor }: RecentProps & {
  id: string
  tagColor?(a: Account): string
}) {
  const { openRecord } = useRecordSheet()
  const [limit, setLimit] = useState(RECENT_PAGE)
  const rows = useMemo(
    () =>
      txs
        .filter((t) => !t.archived && (id === ALL || t.account_id === id || t.to_account_id === id))
        .sort((a, b) => (a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date))),
    [txs, id],
  )
  return (
    <div className="accrecent-list">
      <DayGroups
        txs={rows.slice(0, limit)}
        categories={categories}
        accounts={accounts}
        partnerName={partnerName}
        onOpen={openRecord}
        today={today}
        tagColor={tagColor}
      />
      {rows.length > limit && (
        <button type="button" className="btn-gray accmore" onClick={() => setLimit(limit + RECENT_PAGE)}>
          Показать ещё
        </button>
      )}
    </div>
  )
})

/**
 * «Последние операции»: every record, newest first, as on the home screen. Several accounts: «Все» tags each record with
 * its account in the colour of its card; the filter leaves one account's records, transfers in and out of it included.
 * Each filter item keeps its built list in one grid cell, as «Операции» does: a switch is the pill's slide and a
 * cross-fade, no row is built on the click. The lists are built after the page has opened, the chosen one first and
 * the others one by one when the browser is free.
 */
function RecentOps({ active, multi, ...list }: RecentProps & {
  /** the cards, in their order: the colours come from here */
  active: Account[]
  multi: boolean
}) {
  const [chosen, setChosen] = useState(ALL)
  const views = multi ? [ALL, ...active.map((a) => a.id)] : [ALL]
  const view = views.includes(chosen) ? chosen : ALL
  const [built, setBuilt] = useState<string[]>([])
  const left = views.filter((v) => !built.includes(v))
  const next = view !== ALL && left.includes(view) ? view : left[0]
  useEffect(() => {
    if (!next) return
    const add = () => setBuilt((b) => [...b, next])
    if (built.length === 0) {
      const t = setTimeout(add, prefersReducedMotion() ? 0 : RECENT_AFTER_MS)
      return () => clearTimeout(t)
    }
    if (typeof requestIdleCallback !== 'function') {
      const t = setTimeout(add, 50)
      return () => clearTimeout(t)
    }
    const h = requestIdleCallback(add, { timeout: 500 })
    return () => cancelIdleCallback(h)
  }, [next, built.length])
  const tagColor = useCallback(
    (a: Account) => {
      const i = active.findIndex((x) => x.id === a.id)
      return i < 0 ? 'var(--muted)' : accColor(i)
    },
    [active],
  )
  return (
    <section className="accrecent" data-flip-key="recent" aria-label="Последние операции">
      <h3 className="accrecent-h">Последние операции</h3>
      {multi && (
        <Segmented
          className="accfilter"
          label="Счёт"
          options={[{ value: ALL, label: 'Все' }, ...active.map((a) => ({ value: a.id, label: a.name, dot: tagColor(a) }))]}
          value={view}
          onChange={setChosen}
        />
      )}
      <div className="opstack">
        {views.filter((v) => built.includes(v)).map((v) => (
          <div key={v} className={`oppane${v === view ? ' on' : ''}`} inert={v !== view}>
            <RecentList {...list} id={v} tagColor={multi && v === ALL ? tagColor : undefined} />
          </div>
        ))}
      </div>
    </section>
  )
}

/*
 * «Счета» (spec §4 «Счета», §11 «Раздел «Счета» — переделан полностью», phone part; prototype accounts()/accCard()):
 * the summary «Всего ≈ · Свободно · В целях»; the accounts as bank cards (own gradient, «Основной» on the default,
 * ≈ $ and the currency pills; «В архив» on the others, the pencil opens the name and the bot aliases), swiping
 * sideways with snapping, the dashed «＋ Новый счёт» last; then one card «Операции» (on the PC: a column of its own). «Один баланс»: one card with
 * every currency and «Обмен · Сверка». Archiving shows «Счёт в архиве · Отменить»; the archive itself is in «Архив».
 */
export function Accounts() {
  const { db, repo, now } = useApp()
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const data = useLiveQuery(async () => {
    const [settings, accounts, txs, rates, moves, goals, categories] = await Promise.all([
      db.settings.filter(alive).first(),
      db.accounts.filter(alive).toArray(),
      db.transactions.filter(alive).toArray(),
      db.fx_rates.toArray(),
      db.goal_moves.filter(alive).toArray(),
      db.goals.filter(alive).toArray(),
      db.categories.filter(alive).toArray(),
    ])
    return { settings, accounts, txs, rates, moves, goals, categories }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  // the default first, then by sort
  const active = (data?.accounts ?? [])
    .filter((a) => !a.archived)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort - b.sort)
  const multi = data?.settings?.accounts_mode === 'multi'
  const editing = panel?.kind === 'edit' ? data?.accounts.find((a) => a.id === panel.id) : undefined
  useFlip(screenRef, [active.map((a) => a.id).join(','), multi], !!data)

  async function archive(a: Account) {
    if (panel?.kind === 'edit' && panel.id === a.id) setPanel(null)
    try {
      await repo.put<Account>('accounts', { id: a.id, archived: true })
      toast('Счёт в архиве', { label: 'Отменить', run: () => repo.put<Account>('accounts', { id: a.id, archived: false }) })
    } catch {
      toast(FAILED)
    }
  }

  const bar = (
    <NavBar
      back={{ label: 'Ещё' }}
      title="Счета"
      trailing={
        multi ? (
          <button type="button" className="navbtn strong" onClick={() => setPanel({ kind: 'new' })}>
            <Plus aria-hidden="true" strokeWidth={2.4} />
            Счёт
          </button>
        ) : undefined
      }
    />
  )
  if (!data)
    return (
      <div ref={screenRef} className="accs">
        {bar}
      </div>
    )
  const { settings, accounts, txs, rates, moves, goals, categories } = data
  if (!settings)
    return (
      <div ref={screenRef} className="accs">
        {bar}
        <p className="muted">Сначала завершите настройку</p>
      </div>
    )

  const today = localDate(now(), settings.timezone)
  const all = activeBalances(txs, accounts)
  const total = balanceUsd(all, rates, today)
  const inGoals = reservedUsd(reservingGoalMoves(moves, goals))
  const free = Math.max(0, round2(total - inGoals - (settings.reserve_usd ?? 0)))
  const canArchive = active.length > 1

  return (
    <div ref={screenRef} className="accs">
      {bar}
      {panel?.kind === 'new' && <AccountForm accounts={accounts} onClose={() => setPanel(null)} />}
      {editing && <AccountForm key={editing.id} account={editing} accounts={accounts} blocked={deleteBlock(editing, txs)} onClose={() => setPanel(null)} />}

      <div className="accs-main">
        <div className="accsum" role="group" aria-label="Сводка" data-flip-key="sum">
          <div>
            <span className="label">Всего ≈</span>
            <b className="num">{usdWhole(total)}</b>
          </div>
          <div>
            <span className="label">Свободно</span>
            <b className="num">{usdWhole(free)}</b>
          </div>
          <div>
            <span className="label">В целях</span>
            <b className="num">{usdWhole(inGoals)}</b>
          </div>
        </div>

        <div className="acards" data-no-back-swipe="" data-flip-key="cards">
          {multi ? (
            <>
              {active.map((a, i) => {
                const bal = balances(txs, a.id)
                return (
                  <AccountCard
                    key={a.id}
                    flipKey={a.id}
                    name={a.name}
                    bal={bal}
                    usd={balanceUsd(bal, rates, today)}
                    index={i}
                    single={false}
                    isDefault={a.is_default}
                    onEdit={() => setPanel({ kind: 'edit', id: a.id })}
                    onArchive={!a.is_default && canArchive ? () => void archive(a) : undefined}
                  />
                )
              })}
              <button type="button" className="acard add" onClick={() => setPanel({ kind: 'new' })}>
                <Plus aria-hidden="true" strokeWidth={2} />
                Новый счёт
              </button>
            </>
          ) : (
            <AccountCard flipKey="single" name="Один баланс" bal={all} usd={total} index={0} single isDefault={false} />
          )}
        </div>

        {!multi && (
          <p className="label accfoot" data-flip-key="foot">
            Сейчас режим «Один баланс». Несколько счетов включаются в «Ещё» → «Режим счетов».
          </p>
        )}
        <RecentOps
          txs={txs}
          categories={categories}
          accounts={accounts}
          active={active}
          multi={multi}
          partnerName={settings.partner_name}
          today={today}
        />
      </div>

      <Operations settings={settings} accounts={active} txs={txs} rates={rates} today={today} multi={multi} onHand={all} />
    </div>
  )
}
