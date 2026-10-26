import { useRef, useState } from 'react'
import type { Settings } from '@shared/types.ts'
import { curLabel, curOptions } from '../../ui/currencies.ts'
import { X } from '../../ui/icons.ts'
import { Picker } from '../../ui/Picker.tsx'
import { useFlip } from '../../ui/useFlip.ts'
import { MoreCard, onEnter, useSaveSettings } from './common.tsx'

const CODE = /^[A-Z]{3}$/
const HINT = 'Курс берётся у НБУ — валюта должна быть в его списке'

/**
 * «Валюты» (prototype more()): the currencies as pills, each with ✕ except the base (USD) and the default one —
 * those simply have no ✕ (no empty place for it); «Валюта по умолчанию» as a full-width currency menu;
 * «Добавить валюту» on its own line, the field takes the room and the button keeps its width.
 */
export function CurrenciesSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings(settings)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const chipsRef = useRef<HTMLDivElement>(null)
  // a pill added or removed: the others slide to their place, the new one fades in (spec §6 «Плавная перерисовка»)
  useFlip(chipsRef, [settings.currencies.join(','), settings.default_currency])
  const locked = (c: string) => c === settings.base_currency || c === settings.default_currency

  const remove = (c: string) => {
    if (locked(c)) return // the default and the base currency stay
    void save({ currencies: settings.currencies.filter((x) => x !== c) })
  }

  const add = async () => {
    const value = code.trim().toUpperCase()
    if (!CODE.test(value)) return setError('Код валюты — 3 латинские буквы')
    if (settings.currencies.includes(value)) return setError('Такая валюта уже есть')
    setError('')
    if (await save({ currencies: [...settings.currencies, value] })) setCode('')
  }

  return (
    <MoreCard title="Валюты">
      <div ref={chipsRef} className="mchips">
        {settings.currencies.map((c) => (
          <span key={c} className={`tag${locked(c) ? '' : ' has-x'}`} data-flip-key={`cur-${c}`}>
            {curLabel(c)}
            {!locked(c) && (
              <button type="button" className="x" aria-label={`Убрать ${c}`} onClick={() => remove(c)}>
                <X aria-hidden="true" strokeWidth={2.2} />
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="fld">
        <label htmlFor="m-defcur">Валюта по умолчанию</label>
        <Picker
          id="m-defcur"
          label="Валюта по умолчанию"
          kind="currency"
          value={settings.default_currency}
          options={curOptions(settings.currencies)}
          onChange={(v) => void save({ default_currency: v })}
        />
      </div>
      <div className="fld">
        <label htmlFor="m-newcur">Добавить валюту</label>
        <div className="quick">
          <input
            id="m-newcur"
            className="inp"
            type="text"
            maxLength={3}
            placeholder="PLN"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby="m-curhint"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              if (error) setError('')
            }}
            onKeyDown={onEnter(() => void add())}
          />
          <button type="button" className="btn-acc" onClick={() => void add()}>
            Добавить
          </button>
        </div>
      </div>
      <p id="m-curhint" className={`label${error ? ' err' : ''}`} role={error ? 'alert' : undefined}>
        {error || HINT}
      </p>
    </MoreCard>
  )
}
