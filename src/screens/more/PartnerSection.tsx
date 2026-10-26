import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Settings } from '@shared/types.ts'
import { plural } from '../../ui/dates.ts'
import { UserRound } from '../../ui/icons.ts'
import { Segmented } from '../../ui/Segmented.tsx'
import { partnerLabel } from '../Records.tsx'
import { MoreCard, onEnter, useSaveSettings } from './common.tsx'

const NAME_MAX = 20

/** «маша» → «Маша»; empty → null (the interface then says «Она»). */
export function partnerNameOf(text: string): string | null {
  const t = text.trim().slice(0, NAME_MAX)
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null
}

/**
 * «Второй человек в боте» (spec §9 «Ещё → Второй человек»; prototype more()): the name (up to 20 letters, with a
 * capital; it changes the labels, the letter and the switches everywhere), «Подключена» once she has written to the
 * bot (`partner_seen_at`) or «Ждём /start», and what she can do. The name is saved on leaving the field or Enter.
 */
export function PartnerSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings(settings)
  const [name, setName] = useState(settings.partner_name ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (document.activeElement !== ref.current) setName(settings.partner_name ?? '')
  }, [settings.partner_name])

  const commit = async () => {
    const next = partnerNameOf(name)
    setName(next ?? '')
    // a failed save shows the stored name again (the toast says it did not work)
    if (next !== settings.partner_name && !(await save({ partner_name: next }))) setName(settings.partner_name ?? '')
  }

  const shown = partnerLabel(settings.partner_name)
  const linked = !!settings.partner_seen_at

  return (
    <MoreCard title="Второй человек в боте">
      <div className="fld">
        <label htmlFor="m-pname">Имя</label>
        <input
          ref={ref}
          id="m-pname"
          className="inp"
          type="text"
          maxLength={NAME_MAX}
          placeholder="Например, Маша"
          autoComplete="off"
          autoCapitalize="words"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onEnter(() => void commit())}
        />
      </div>
      <div className="mrow">
        <span className="mrow-t">
          <span className="ic sm" style={{ '--c': 'var(--act-edit)' } as CSSProperties} aria-hidden="true">
            <UserRound strokeWidth={2} />
          </span>
          Telegram-бот
        </span>
        <span className={`mpill ${linked ? 'ok' : 'warn'}`}>{linked ? 'Подключена' : 'Ждём /start'}</span>
      </div>
      <p className="label">
        {`${shown} пишет траты боту так же, как ты, и видит то же, что ты: баланс, отчёты, цели. Каждая её трата приходит тебе сообщением. В списках её записи помечены буквой «${shown.charAt(0)}», в отчёте есть разделение «Я / ${shown}».`}
      </p>
    </MoreCard>
  )
}

const REMIND: { value: string; label: string }[] = [
  { value: '0', label: 'Выкл' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '7', label: '7' },
]

/** «Telegram-бот» → «Напоминать, если нет записей» (spec §10): Выкл / 2 / 3 / 5 / 7 days, `remind_after_days`. */
export function BotSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings(settings)
  const days = settings.remind_after_days ?? 2
  return (
    <MoreCard title="Telegram-бот">
      <span className="flabel">Напоминать, если нет записей, дней</span>
      <Segmented
        label="Напоминание"
        options={REMIND}
        value={String(days)}
        onChange={(v) => void save({ remind_after_days: Number(v) as Settings['remind_after_days'] })}
      />
      <p className="label">
        {`Каждый день сервер сам проверяет базу, чтобы она не уснула. ${
          days ? `Если записей не было ${plural(days, 'день', 'дня', 'дней')}, бот напомнит в Telegram вам обоим.` : 'Напоминания выключены.'
        } Проверить связь — /ping или «сделай проверку».`}
      </p>
    </MoreCard>
  )
}
