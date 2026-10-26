import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from '../ui/icons.ts'

export interface MenuItem {
  label: string
  icon?: LucideIcon
  danger?: boolean
  run(): void
}

/*
 * The right-click menu (spec §11 «Мышь и клавиатура»; prototype ctxMenu): a solid Windows surface at the pointer,
 * kept inside the window. The first item takes focus; ↑ ↓ go round, Enter runs, Esc or a click elsewhere closes
 * (focus goes back to where it was).
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const back = useRef<Element | null>(null)

  useLayoutEffect(() => {
    back.current = document.activeElement
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - w - 4)), top: Math.max(4, Math.min(y, window.innerHeight - h - 4)) })
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const blur = () => onClose()
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
    }
  }, [onClose])

  const close = (refocus: boolean) => {
    onClose()
    const b = back.current
    if (refocus && b instanceof HTMLElement && b.isConnected) b.focus({ preventScroll: true })
  }

  const keyDown = (e: KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const n = buttons.length
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  return createPortal(
    <div ref={ref} className="ctx" role="menu" style={pos} onKeyDown={keyDown} onContextMenu={(e) => e.preventDefault()}>
      {items.map(({ label, icon: Icon, danger, run }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          className={danger ? 'danger' : undefined}
          onClick={() => {
            close(true)
            run()
          }}
        >
          {Icon && <Icon aria-hidden="true" strokeWidth={2} />}
          {label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
