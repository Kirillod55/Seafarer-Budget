import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { curLabel, curName, curSign } from './currencies.ts'
import { Check, ChevronsUpDown, Plus } from './icons.ts'
import { prefersReducedMotion } from './motion.ts'
import './ui.css'

export interface PickerOption {
  value: string
  label: string
  /** Account balance on the right («≈ $1,475»); for currencies — the name under the code («Гривна»). */
  sub?: string
  /** Shown before the label, e.g. <CategoryIcon size="sm"/> — inside the menu it turns into a solid tile. */
  icon?: ReactNode
}

const OTHER = '__other'

/*
 * Field with a drop-down glass menu (spec §6 «Все выпадающие списки — меню», «Выбор счёта «Откуда / Куда»»,
 * §4 «Окно выбора валюты»; prototype gp/openPicker/openCurOther/closePicker). The menu grows out of the field with
 * a spring, has a tick at the chosen item, works with the arrows, Enter and Esc, and closes on a tap outside.
 * kind 'currency': a round badge with the sign, the code in bold and its name under it; with `allowOther` the last
 * item «Другая валюта…» opens a small window for a 3-letter code, which is then chosen and added to this menu.
 * The menu lives in a portal on <body> and carries .glass, so the back swipe stays off while it is open.
 * The visible caption is the screen's own <label htmlFor={id}>; `label` names the field and the menu for
 * screen readers.
 */
export function Picker({
  id,
  label,
  value,
  options,
  onChange,
  kind = 'account',
  allowOther = false,
  onAdd,
}: {
  id: string
  label: string
  value: string
  options: PickerOption[]
  onChange(value: string): void
  kind?: 'currency' | 'category' | 'account'
  allowOther?: boolean
  /** A code entered in «Другая валюта…» (already upper case, 3 letters) — for the caller to keep it. */
  onAdd?(code: string): void
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'list' | 'other' | null>(null)
  // codes added through «Другая валюта…» that the given options do not have (yet)
  const [added, setAdded] = useState<string[]>([])
  // the menu that is closing: kept for its 0.22 s fade, without a role
  const [leaving, setLeaving] = useState<'list' | 'other' | null>(null)
  const [swaps, setSwaps] = useState(0)
  // each opening mounts a fresh menu (its items fly in again, the focus goes to the chosen one)
  const [opens, setOpens] = useState(0)
  const show = (what: 'list' | 'other') => {
    setLeaving(null)
    setOpens((n) => n + 1)
    setOpen(what)
  }

  const cur = kind === 'currency'
  const list: PickerOption[] = [
    ...options,
    ...added.filter((c) => !options.some((o) => o.value === c)).map((c) => ({ value: c, label: curLabel(c), sub: curName(c) })),
  ]
  const selected = list.find((o) => o.value === value) ?? { value, label: cur ? curLabel(value) : value }

  const close = (focusBack: boolean) => {
    if (!prefersReducedMotion()) setLeaving(open)
    setOpen(null)
    if (focusBack) btn.current?.focus()
  }
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(null), 220)
    return () => clearTimeout(t)
  }, [leaving])

  const choose = (v: string) => {
    if (v === OTHER) {
      show('other')
      return
    }
    close(true)
    if (v !== value) {
      setSwaps((n) => n + 1)
      onChange(v)
    }
  }

  const addOther = (code: string) => {
    if (!list.some((o) => o.value === code)) setAdded((a) => [...a, code])
    onAdd?.(code)
    close(true)
    if (code !== value) {
      setSwaps((n) => n + 1)
      onChange(code)
    }
  }

  // the window moves with nothing: a rotation or resize simply closes it
  useEffect(() => {
    if (!open) return
    const off = () => close(false)
    window.addEventListener('resize', off)
    return () => window.removeEventListener('resize', off)
  })

  const menuOptions = cur && allowOther ? [...list, { value: OTHER, label: 'Другая валюта…', sub: 'Ввести код вручную, например GEL' }] : list

  return (
    <>
      <button
        ref={btn}
        type="button"
        id={id}
        className="picker"
        value={value}
        aria-haspopup="listbox"
        aria-expanded={open !== null}
        aria-label={`${label}: ${cur ? value : selected.label}`}
        onClick={() => (open ? close(false) : show('list'))}
        onKeyDown={(e) => {
          // the arrows open a closed field, like a native select
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            show('list')
          }
        }}
      >
        <span key={swaps} className={`pv${swaps ? ' swap' : ''}`}>
          {cur ? (
            <>
              <span className="cbadge sm" aria-hidden="true">
                {curSign(value)}
              </span>
              {value}
            </>
          ) : (
            <>
              {selected.icon}
              <span className="pv-t">{selected.label}</span>
            </>
          )}
        </span>
        <span className="chev2" aria-hidden="true">
          <ChevronsUpDown strokeWidth={2.2} />
        </span>
      </button>
      {(open ?? leaving) === 'list' && (
        <Menu
          key={opens}
          leaving={!open}
          anchor={btn}
          label={label}
          kind={kind}
          options={menuOptions}
          value={value}
          onChoose={choose}
          onClose={() => close(true)}
        />
      )}
      {(open ?? leaving) === 'other' && <OtherCurrency key={opens} leaving={!open} anchor={btn} onAdd={addOther} onClose={() => close(true)} />}
      {open && createPortal(<div className="pick-catch" onClick={() => close(true)} />, document.body)}
    </>
  )
}

/**
 * Place a menu under the field (above it when there is no room below; when neither side fits, on the larger side
 * with its height cut to fit and the items scrolling), clamped to the window; it grows from the field.
 */
function usePlace(anchor: RefObject<HTMLButtonElement | null>, menu: RefObject<HTMLDivElement | null>, minW: number) {
  useLayoutEffect(() => {
    const a = anchor.current
    const m = menu.current
    if (!a || !m) return
    const r = a.getBoundingClientRect()
    const w = Math.min(Math.max(r.width, minW), innerWidth - 16)
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8)
    m.style.width = `${w}px`
    m.style.left = `${left}px`
    // 8 px from the field and 8 px from the window edge on either side
    const roomBelow = innerHeight - r.bottom - 16
    const roomAbove = r.top - 16
    let h = m.offsetHeight
    let below = true
    if (h > roomBelow) {
      if (h <= roomAbove) below = false
      else {
        // fits on neither side: the larger side, scrolling inside
        below = roomBelow >= roomAbove
        const room = Math.max(below ? roomBelow : roomAbove, 120)
        m.style.maxHeight = `${room}px`
        m.style.overflowY = 'auto'
        h = Math.min(h, room)
      }
    }
    m.style.top = `${below ? r.bottom + 8 : r.top - 8 - h}px`
    m.style.setProperty('--ox', `${r.left + r.width / 2 - left}px`)
    m.style.setProperty('--oy', below ? '0%' : '100%')
  }, [anchor, menu, minW])
}

function Menu({
  leaving,
  anchor,
  label,
  kind,
  options,
  value,
  onChoose,
  onClose,
}: {
  /** closed: fading out for 0.22 s — no role, no focus, not clickable */
  leaving: boolean
  anchor: RefObject<HTMLButtonElement | null>
  label: string
  kind: 'currency' | 'category' | 'account'
  options: PickerOption[]
  value: string
  onChoose(v: string): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  usePlace(anchor, ref, 240)

  useLayoutEffect(() => {
    const opts = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.opt') ?? [])]
    ;(opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0])?.focus({ preventScroll: true })
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const opts = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.opt') ?? [])]
    const i = opts.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      opts[(i + 1) % opts.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      opts[(i - 1 + opts.length) % opts.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      opts[e.key === 'Home' ? 0 : opts.length - 1]?.focus()
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault()
      onChoose(opts[i].dataset.opt!)
    } else if (e.key === 'Tab') {
      e.preventDefault() // focus stays in the menu while it is open
    }
  }

  const cur = kind === 'currency'
  return createPortal(
    <div
      ref={ref}
      className={`glass${cur ? ' curmenu' : ''}${leaving ? ' out' : ''}`}
      role={leaving ? undefined : 'listbox'}
      aria-label={leaving ? undefined : label}
      aria-hidden={leaving || undefined}
      inert={leaving}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const on = o.value === value
        const other = o.value === OTHER
        return (
          <button
            key={o.value}
            type="button"
            className={`opt${other ? ' other' : ''}`}
            role={leaving ? undefined : 'option'}
            aria-selected={leaving ? undefined : on}
            data-opt={o.value}
            style={{ '--i': i } as CSSProperties}
            onClick={() => onChoose(o.value)}
          >
            <span className="chk" aria-hidden="true">
              {on && <Check strokeWidth={2.6} />}
            </span>
            {cur ? (
              <>
                <span className={`cbadge${other ? ' plus' : ''}`} aria-hidden="true">
                  {other ? '+' : curSign(o.value)}
                </span>
                <span className="cnm">
                  <b>{other ? o.label : o.value}</b>
                  <small>{other ? o.sub : (o.sub ?? curName(o.value))}</small>
                </span>
              </>
            ) : (
              <>
                {o.icon}
                <span className="opt-t">{o.label}</span>
                {o.sub && <span className="sub num">{o.sub}</span>}
              </>
            )}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

/** «Другая валюта…»: a small glass window with the 3-letter code field (prototype openCurOther). */
function OtherCurrency({
  leaving,
  anchor,
  onAdd,
  onClose,
}: {
  leaving: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onAdd(code: string): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState(false)
  usePlace(anchor, ref, 280)
  useEffect(() => input.current?.focus({ preventScroll: true }), [])

  const ok = () => {
    if (!/^[A-Z]{3}$/.test(code)) {
      setErr(true)
      input.current?.focus()
      return
    }
    onAdd(code)
  }

  return createPortal(
    <div
      ref={ref}
      className={`glass curother${leaving ? ' out' : ''}`}
      role={leaving ? undefined : 'dialog'}
      aria-label={leaving ? undefined : 'Другая валюта'}
      aria-hidden={leaving || undefined}
      inert={leaving}
    >
      <label htmlFor="co-in">Код валюты</label>
      <div className="co-row">
        <input
          ref={input}
          id="co-in"
          maxLength={3}
          placeholder="GEL"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={err}
          aria-describedby="co-hint"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))
            setErr(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ok()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <button type="button" className="co-ok" onClick={ok}>
          <Plus aria-hidden="true" strokeWidth={2.4} />
          Добавить
        </button>
      </div>
      <p id="co-hint" className={`co-hint${err ? ' err' : ''}`} aria-live="polite">
        Три латинские буквы, как в банке: GEL, RON, CHF
      </p>
    </div>,
    document.body,
  )
}

