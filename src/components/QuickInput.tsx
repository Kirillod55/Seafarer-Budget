import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { parseMessage } from '@shared/parser.ts'
import { CURRENCY_SYMBOL } from '@shared/defaults.ts'
import { useApp } from '../context.tsx'
import { ArrowUp } from '../ui/icons.ts'
import './quick-input.css'

const EXAMPLE_HINT = 'Не нашёл сумму. Напишите, например: кофе 80, такси 15 eur, +3000 usd'
const GOAL_HINT = 'Цели появятся позже. Пока записывайте расходы и доходы: кофе 80'
const COMMAND_HINT = 'Команды появятся позже. Пока записывайте расходы и доходы: кофе 80'
const NO_SETTINGS_HINT = 'Сначала завершите первый запуск.'

interface Feedback {
  kind: 'ok' | 'hint'
  text: string
}

/** The standing hint (shown on focus): the default currency by its sign, or its code. */
function usageHint(currency: string | undefined): string {
  const cur = currency ? (CURRENCY_SYMBOL[currency] ?? currency) : '$'
  return `Сумма, валюта (${cur} по умолчанию) и слово про трату. «+» перед суммой — доход`
}

/*
 * Quick input (spec §3 item 5, §6 «Подсказка под строкой ввода»): «кофе 80…» + the lime send button with an arrow up
 * («＋» is the new record in the header). The hint shows only while the field has focus, after an error or after a
 * record («Записал: Кафе и рестораны · ₴80» — an expense without «−»).
 */
export function QuickInput({ onSaved }: { onSaved?: () => void }) {
  const { db, repo, now } = useApp()
  const [text, setText] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const defaultCurrency = useLiveQuery(async () => (await db.settings.filter(alive).first())?.default_currency, [db])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const settings = await db.settings.filter(alive).first()
      if (!settings) {
        setFeedback({ kind: 'hint', text: NO_SETTINGS_HINT })
        return
      }
      // only live rows: a category or account in the undo bin is never filed into
      const [categories, accounts] = await Promise.all([db.categories.filter(alive).toArray(), db.accounts.filter(alive).toArray()])
      const parsed = parseMessage(value, {
        currencies: settings.currencies,
        defaultCurrency: settings.default_currency,
        categories,
        accounts,
        accountsMode: settings.accounts_mode,
        today: localDate(now(), settings.timezone),
      })

      if (parsed.type === 'error') {
        setFeedback({ kind: 'hint', text: EXAMPLE_HINT })
        return
      }
      if (parsed.type === 'goal') {
        setFeedback({ kind: 'hint', text: GOAL_HINT })
        return
      }
      if (parsed.type === 'command') {
        setFeedback({ kind: 'hint', text: parsed.command === 'help' ? EXAMPLE_HINT : COMMAND_HINT })
        return
      }

      const live = accounts.filter((a) => alive(a) && !a.archived).sort((a, b) => a.sort - b.sort)
      const account = live.find((a) => a.id === parsed.accountId) ?? live.find((a) => a.is_default) ?? live[0]
      if (!account) {
        setFeedback({ kind: 'hint', text: NO_SETTINGS_HINT })
        return
      }

      // R21: an expense that matches no category goes to «Прочее», like the bot does.
      const categoryId =
        parsed.categoryId ??
        (parsed.kind === 'expense'
          ? (categories.find((c) => c.name === 'Прочее' && c.kind === 'expense' && alive(c) && !c.archived)?.id ?? null)
          : null)

      await repo.addTransaction({
        kind: parsed.kind,
        amount: parsed.amount,
        currency: parsed.currency,
        account_id: account.id,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: categoryId,
        date: parsed.date,
        note: parsed.note,
        source: 'app',
        author: 'owner',
        archived: false,
      })
      const category = categories.find((c) => c.id === categoryId)
      const sign = parsed.kind === 'income' ? '+' : ''
      setFeedback({
        kind: 'ok',
        text: `Записал: ${category?.name ?? 'Без категории'} · ${sign}${money(parsed.amount, parsed.currency)}`,
      })
      setText('')
      onSaved?.()
    } catch (err) {
      setFeedback({ kind: 'hint', text: `Не удалось сохранить: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }

  const show = focused || feedback !== null
  return (
    <div className="qwrap">
      <form className="qform" onSubmit={submit} autoComplete="off">
        <input
          className="qinput"
          type="text"
          aria-label="Быстрая запись"
          placeholder="кофе 80, такси 15 eur…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete="off"
          enterKeyHint="done"
        />
        <button className="qsend" type="submit" disabled={busy} aria-label="Записать">
          <ArrowUp strokeWidth={2.6} aria-hidden="true" />
        </button>
      </form>
      <p className={`qhint${show ? ' show' : ''}${feedback?.kind === 'hint' ? ' err' : ''}`} aria-live="polite">
        {feedback ? feedback.text : usageHint(defaultCurrency)}
      </p>
    </div>
  )
}
