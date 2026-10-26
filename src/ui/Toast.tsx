import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ui.css'

export interface ToastAction {
  label: string
  /** May return a promise (e.g. repo.restore): a rejection shows «Не получилось — попробуй ещё раз». */
  run(): void | Promise<unknown>
  /**
   * Runs when the toast goes without its action: the 6 s ran out or another toast replaced it. For an undo that
   * cannot be taken back once it reaches the server (an account's `deleted = true` is final): the deletion is
   * written only here, once «Отменить» is no longer offered.
   * Not a guaranteed commit: it does not run when the host unmounts (sign-out) or the app is closed while the toast
   * is up — the action is then simply not taken, so it must be safe to skip. Check the data again inside it: it runs
   * seconds after the toast was shown.
   */
  expire?(): void
}

type Show = (msg: string, action?: ToastAction) => void

/*
 * The toast with «Отменить» (spec §6 «Плашка «Отменить»»; prototype toast()): one line above the tab bar, 6 s,
 * kept while a finger or the pointer is on it, then for the rest of the 6 s but at least 2.5 s. A new toast replaces
 * the old one; a failed (rejected) action says «Не получилось — попробуй ещё раз».
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
const FAILED = 'Не получилось — попробуй ещё раз'

export function ToastHost() {
  const [toast, setToast] = useState<{ id: number; msg: string; action?: ToastAction } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // when the 6 s of the current toast run out (ms since epoch)
  const deadline = useRef(0)
  const ids = useRef(0)

  // the action of the toast on screen: its expire() runs once, unless «Отменить» was pressed
  const current = useRef<ToastAction | undefined>(undefined)
  const expireCurrent = () => {
    const a = current.current
    current.current = undefined
    a?.expire?.()
  }

  const hideIn = (ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setToast(null)
      expireCurrent()
    }, ms)
  }
  const hold = () => clearTimeout(timer.current)
  // let go: whatever is left of the 6 s, but at least 2.5 s more
  const release = () => hideIn(Math.max(deadline.current - Date.now(), AFTER_TOUCH_MS))

  useEffect(() => {
    const mine: Show = (msg, action) => {
      expireCurrent()
      current.current = action
      setToast({ id: ++ids.current, msg, action })
      deadline.current = Date.now() + SHOW_MS
      hideIn(SHOW_MS)
    }
    host = mine
    return () => {
      if (host === mine) host = null
      clearTimeout(timer.current)
    }
  }, [])

  const act = (action: ToastAction) => {
    clearTimeout(timer.current)
    current.current = undefined
    setToast(null)
    // «Отменить» usually restores from the bin (a promise): if that fails, say so instead of failing silently
    const failed = () => show(FAILED)
    try {
      const r = action.run()
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(failed)
    } catch {
      failed()
    }
  }

  // The live region stays on the page for good, so screen readers announce each new text put into it.
  return createPortal(
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div
          key={toast.id}
          className="toast"
          onPointerEnter={hold}
          onPointerLeave={release}
          onTouchStart={hold}
          onTouchEnd={release}
          onTouchCancel={release}
        >
          <span className="toast-msg">{toast.msg}</span>
          {toast.action && (
            <button type="button" onClick={() => act(toast.action!)}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
