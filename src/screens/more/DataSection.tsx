import { useId, useState } from 'react'
import { alive } from '@shared/alive.ts'
import { balances } from '@shared/calc.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Account, Settings, Transaction } from '@shared/types.ts'
import { useApp } from '../../context.tsx'
import { csvFileName, downloadCsv, toCsv } from '../../export.ts'
import { parseAmount } from '../../lib/amount.ts'
import { Segmented } from '../../ui/Segmented.tsx'
import { useToast } from '../../ui/Toast.tsx'
import { FAILED, MoreCard, onEnter, useSaveSettings } from './common.tsx'

const RECONCILE_NOTE = 'Сверка'

const MODES: { value: Settings['accounts_mode']; label: string }[] = [
  { value: 'single', label: 'Один баланс' },
  { value: 'multi', label: 'Несколько счетов' },
]

/** «Режим счетов»: switching keeps every account and record (only `accounts_mode` is written). */
export function ModeSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings(settings)
  return (
    <MoreCard title="Режим счетов">
      <Segmented<Settings['accounts_mode']>
        label="Режим счетов"
        options={MODES}
        value={settings.accounts_mode}
        onChange={(accounts_mode) => void save({ accounts_mode })}
      />
      <p className="label">Переключение не удаляет ни счета, ни записи.</p>
    </MoreCard>
  )
}

/* ---------- «Сверка» ---------- */

function ReconcileRow({
  name,
  current,
  currency,
  accountId,
  today,
}: {
  /** «UAH» or «Наличные USD» — names the field and the button */
  name: string
  current: number
  currency: string
  accountId: string | undefined
  today: string
}) {
  const { repo } = useApp()
  const toast = useToast()
  const inputId = useId()
  const [real, setReal] = useState('')
  const [hint, setHint] = useState<{ text: string; err?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy) return
    const value = parseAmount(real)
    if (real.trim() === '' || !Number.isFinite(value)) return setHint({ text: 'Введите сумму', err: true })
    if (!accountId) return setHint({ text: 'Нет счёта для сверки', err: true })
    const diff = round2(value - current)
    if (diff === 0) return setHint({ text: 'Всё сходится, корректировка не нужна' })
    setBusy(true)
    try {
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
      setReal('')
      setHint({ text: `Корректировка ${diff > 0 ? '+' : ''}${money(diff, currency)}` })
    } catch {
      setHint(null)
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="recon">
      <div className="mrow">
        <label htmlFor={inputId} className="flabel">
          {name}
        </label>
        <span className="num mnow">{`сейчас ${money(current, currency)}`}</span>
      </div>
      <div className="quick">
        <input
          id={inputId}
          className="inp num"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={String(Math.round(current))}
          aria-label={`Реальный остаток ${name}`}
          aria-invalid={!!hint?.err}
          value={real}
          onChange={(e) => {
            setReal(e.target.value)
            if (hint) setHint(null)
          }}
          onKeyDown={onEnter(() => void submit())}
        />
        <button type="button" className="btn-gray" aria-label={`Сверить ${name}`} disabled={busy} onClick={() => void submit()}>
          Сверить
        </button>
      </div>
      {hint && (
        <p className={`label${hint.err ? ' err' : ''}`} role={hint.err ? 'alert' : 'status'}>
          {hint.text}
        </p>
      )}
    </div>
  )
}

/**
 * «Сверка»: the real amount in hand → the difference is written as an adjustment dated today (one row per currency;
 * in «Несколько счетов» per account and currency; the default currency and those with money in them).
 * Task 14 adds the same to «Счета → Операции».
 */
export function ReconcileSection({
  settings,
  accounts,
  txs,
  today,
}: {
  settings: Settings
  accounts: Account[]
  txs: Transaction[]
  today: string
}) {
  const active = accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort)
  const defaultAccount = active.find((a) => a.is_default) ?? active[0]
  // the default currency and every currency with money in it (a zero row for each listed currency is just noise)
  const currenciesOf = (bal: Record<string, number>) => [
    ...new Set([settings.default_currency, ...settings.currencies, ...Object.keys(bal)]),
  ].filter((c) => c === settings.default_currency || (bal[c] ?? 0) !== 0)

  return (
    <MoreCard title="Сверка" className="mrecon">
      <p className="label">Пересчитал наличку — впиши реальную сумму, разницу запишу корректировкой.</p>
      {settings.accounts_mode === 'multi'
        ? active.flatMap((a) => {
            const bal = balances(txs, a.id)
            return currenciesOf(bal).map((c) => (
              <ReconcileRow key={`${a.id}:${c}`} name={`${a.name} ${c}`} current={bal[c] ?? 0} currency={c} accountId={a.id} today={today} />
            ))
          })
        : (() => {
            const bal = balances(txs)
            return currenciesOf(bal).map((c) => (
              <ReconcileRow key={c} name={c} current={bal[c] ?? 0} currency={c} accountId={defaultAccount?.id} today={today} />
            ))
          })()}
    </MoreCard>
  )
}

/* ---------- «Резервная копия» ---------- */

/**
 * «Резервная копия»: every record in one CSV for Excel (`seafarer-budget-ГГГГ-ММ-ДД.csv`, the «Кто» column and the
 * second half of transfers). «Загрузить из CSV» joins this card in Task 13 (ImportPanel).
 */
export function BackupSection({ today, partnerName }: { today: string; partnerName: string | null }) {
  const { db } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function download() {
    if (busy) return
    setBusy(true)
    try {
      const [txs, categories, accounts] = await Promise.all([
        db.transactions.filter(alive).toArray(),
        db.categories.toArray(),
        db.accounts.toArray(),
      ])
      txs.sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
      downloadCsv(csvFileName(today), toCsv(txs, categories, accounts, partnerName))
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <MoreCard title="Резервная копия">
      <p className="label">Все записи одним файлом для Excel.</p>
      <button type="button" className="btn-gray" disabled={busy} onClick={() => void download()}>
        Скачать CSV
      </button>
      {/* Task 13: «Загрузить из CSV» (ImportPanel) goes here */}
    </MoreCard>
  )
}
