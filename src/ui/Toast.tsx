import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ui.css'

export interface ToastAction {
  label: string
  run(): void
}

type Show = (msg: string, action?: ToastAction) => void

/*
 * The toast with «Отменить» (spec §6 «Плашка «Отменить»»; prototype toast()): one line above the tab bar, 6 s,
 * kept while a finger or the pointer is on it and for 2.5 s after. A new toast replaces the old one.
 * <ToastHost/> is mounted once (in Shell); any screen calls useToast(). The host registers itself here, so the
 * hook needs no provider around the screens.
 */
let host: Show | null = null

const show: Show = (msg, action) => {
  if (host) host(msg, action)
  else if (import.meta.env.DEV) console.warn('useToast: no <ToastHost/> mounted —', msg)
}

/** `toast('Запись удалена', { label: 'Отменить', run: () => repo.restore(batch) })`. Stable across renders. */
export function useToast(): Show {
  return show
}

const SHOW_MS = 6000
const AFTER_TOUCH_MS = 2500

export function ToastHost() {
  const [toast, setToast] = useState<{ id: number; msg: string; action?: ToastAction } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ids = useRef(0)

  const hideIn = (ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), ms)
  }
  const hold = () => clearTimeout(timer.current)
  const release = () => hideIn(AFTER_TOUCH_MS)

  useEffect(() => {
    const mine: Show = (msg, action) => {
      setToast({ id: ++ids.current, msg, action })
      hideIn(SHOW_MS)
    }
    host = mine
    return () => {
      if (host === mine) host = null
      clearTimeout(timer.current)
    }
  }, [])

  if (!toast) return null
  return createPortal(
    <div
      key={toast.id}
      className="toast"
      role="status"
      onPointerEnter={hold}
      onPointerLeave={release}
      onTouchStart={hold}
      onTouchEnd={release}
      onTouchCancel={release}
    >
      <span className="toast-msg">{toast.msg}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            clearTimeout(timer.current)
            setToast(null)
            toast.action!.run()
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>,
    document.body,
  )
}
