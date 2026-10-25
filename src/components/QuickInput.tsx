import { useState, type FormEvent } from 'react'
import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { parseMessage } from '@shared/parser.ts'
import { useApp } from '../context.tsx'

const EXAMPLE_HINT = 'Не нашёл сумму. Напишите, например: кофе 80, такси 15 eur, +3000 usd'
const GOAL_HINT = 'Цели появятся позже. Пока записывайте расходы и доходы: кофе 80'
const COMMAND_HINT = 'Команды появятся позже. Пока записывайте расходы и доходы: кофе 80'
const NO_SETTINGS_HINT = 'Сначала завершите первый запуск.'

interface Feedback {
  kind: 'ok' | 'hint'
  text: string
}

export function QuickInput({ onSaved }: { onSaved?: () => void }) {
  const { db, repo, now } = useApp()
  const [text, setText] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)

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
      })
      const category = categories.find((c) => c.id === categoryId)
      const sign = parsed.kind === 'expense' ? '-' : '+'
      setFeedback({
        kind: 'ok',
        text: `Записано: ${sign}${money(parsed.amount, parsed.currency)} · ${category?.name ?? 'Без категории'}`,
      })
      setText('')
      onSaved?.()
    } catch (err) {
      setFeedback({ kind: 'hint', text: `Не удалось сохранить: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="quick" onSubmit={submit}>
      <div className="quick-row">
        <input
          className="quick-input"
          type="text"
          aria-label="Быстрая запись"
          placeholder="Например: кофе 80"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          enterKeyHint="done"
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Добавить
        </button>
      </div>
      {feedback && (
        <p className={`quick-feedback ${feedback.kind === 'ok' ? 'ok' : 'hint'}`} role="status">
          {feedback.text}
        </p>
      )}
    </form>
  )
}
