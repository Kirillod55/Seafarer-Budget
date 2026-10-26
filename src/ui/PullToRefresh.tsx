import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, RefreshCw, X } from './icons.ts'
import { prefersReducedMotion } from './motion.ts'
import './pull.css'

/** Rubber resistance (spec §6): the strip's height for a finger travel of `dy` px — never more than 100. */
export function pullHeight(dy: number): number {
  return dy <= 0 ? 0 : 100 * (1 - Math.exp(-dy / 150))
}

/** Past this height a release syncs. */
export const PULL_THRESHOLD = 54
const LOADING_HEIGHT = 64
/** the spinner shows at least this long, so a quick sync does not just flash */
const MIN_LOADING_MS = 600
const DONE_HOLD_MS = 700
const ERROR_HOLD_MS = 1400
const COLLAPSE_MS = 520

type Phase = 'idle' | 'pull' | 'armed' | 'loading' | 'done' | 'error'

const TEXT: Record<Exclude<Phase, 'error'>, string> = {
  idle: 'Потяни, чтобы синхронизировать',
  pull: 'Потяни, чтобы синхронизировать',
  armed: 'Отпусти — синхронизирую',
  loading: 'Синхронизирую…',
  done: 'Синхронизировано',
}

/** Things on top of the page own the gestures: the record sheet, glass menus, dialogs. */
function blocked(): boolean {
  if (document.documentElement.dataset.editing === '1') return true
  return !!document.querySelector('[role="menu"], [aria-modal="true"]')
}

const scrolled = () => (window.scrollY || document.documentElement.scrollTop || 0) > 0

/*
 * Pull down to sync (spec §6 «Потянуть главную вниз — плавно, как на iPhone»; prototype bindPull/runPull). Only from
 * the very top of the page and only when the finger goes mostly down — a sideways move is left to the swipe rows
 * (and the back swipe), so the gestures never fight. The strip grows with rubber resistance, the two arrows fade
 * in and turn after the finger; at 54 px they grow a little, a light vibration, «Отпусти — синхронизирую». After
 * the release the arrows keep spinning from the same angle while `onRefresh` runs, then a tick «Синхронизировано»
 * (or a short error: `onRefresh` rejects with the text) and the strip folds away. A short pull just goes back.
 * Off while `disabled`, the record sheet or a menu is open, and during a refresh.
 */
export function PullToRefresh({
  onRefresh,
  disabled = false,
  children,
}: {
  /** Resolves when synced; rejects with an Error whose message is the short text to show. */
  onRefresh(): Promise<void>
  disabled?: boolean
  children: ReactNode
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const icon = useRef<HTMLSpanElement>(null)
  const arrows = useRef<HTMLSpanElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const opts = useRef({ onRefresh, disabled })
  opts.current = { onRefresh, disabled }

  useEffect(() => {
    const el = wrap.current
    const st = strip.current
    const pi = icon.current
    const pr = arrows.current
    if (!el || !st || !pi || !pr) return

    let alive = true
    let busy = false
    let y0: number | null = null
    let x0 = 0
    let mode: 'pull' | 'none' | null = null
    let h = 0
    let rot = 0
    let armed = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t)
          resolve()
        }, ms)
        timers.add(t)
      })

    const setHeight = (px: number) => {
      st.style.height = `${px}px`
    }
    const resetIcon = () => {
      pi.style.opacity = ''
      pi.style.transform = ''
    }

    const collapse = () => {
      st.classList.remove('dragging')
      resetIcon()
      pr.style.transform = ''
      setHeight(0)
    }

    const start = (x: number, y: number, target: EventTarget | null) => {
      if (busy || opts.current.disabled || blocked() || scrolled()) return
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      y0 = y
      x0 = x
      mode = null
      h = 0
      armed = false
    }

    const move = (x: number, y: number, e: Event) => {
      if (y0 === null) return
      const dy = y - y0
      if (mode === null) {
        const dx = x - x0
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        // mostly down: ours; sideways or up: the swipe rows', the back swipe's or the page's
        mode = dy > 0 && dy > Math.abs(dx) * 1.2 && !blocked() ? 'pull' : 'none'
        if (mode === 'pull') setPhase('pull')
      }
      if (mode !== 'pull') return
      if (e.cancelable) e.preventDefault()
      st.classList.add('dragging')
      h = pullHeight(dy)
      const p = Math.min(1, h / PULL_THRESHOLD)
      rot = p * 300
      setHeight(h)
      pi.style.opacity = String(p)
      pi.style.transform = `scale(${0.6 + 0.4 * p})`
      pr.style.transform = `rotate(${rot}deg)`
      const arm = h >= PULL_THRESHOLD
      if (arm !== armed) {
        armed = arm
        setPhase(arm ? 'armed' : 'pull')
        if (arm) navigator.vibrate?.(8)
      }
    }

    const run = async () => {
      busy = true
      st.classList.remove('dragging')
      resetIcon()
      pr.style.transform = ''
      pr.style.setProperty('--r0', `${rot}deg`)
      setHeight(LOADING_HEIGHT)
      setPhase('loading')
      const t0 = performance.now()
      let failure: string | null = null
      try {
        await opts.current.onRefresh()
      } catch (err) {
        failure = err instanceof Error && err.message ? err.message : 'Не удалось синхронизировать'
      }
      const rest = MIN_LOADING_MS - (performance.now() - t0)
      if (rest > 0 && failure === null && !prefersReducedMotion()) await later(rest)
      if (!alive) return
      if (failure !== null) {
        setError(failure)
        setPhase('error')
      } else setPhase('done')
      await later(failure !== null ? ERROR_HOLD_MS : DONE_HOLD_MS)
      if (!alive) return
      setHeight(0)
      await later(COLLAPSE_MS)
      if (!alive) return
      busy = false
      setPhase('idle')
    }

    const end = () => {
      if (y0 === null) return
      y0 = null
      const was = mode
      mode = null
      if (was !== 'pull') return
      // a drag is not a tap: the click that follows a mouse drag must not open the row under it
      const swallow = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      if (armed && h > 0) void run()
      else {
        collapse()
        setPhase('idle')
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      start(e.touches[0].clientX, e.touches[0].clientY, e.target)
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t) move(t.clientX, t.clientY, e)
    }
    const onTouchEnd = () => end()
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button === 0) start(e.clientX, e.clientY, e.target)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') move(e.clientX, e.clientY, e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') end()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      alive = false
      for (const t of timers) clearTimeout(t)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  return (
    <div ref={wrap} className="ptr-wrap">
      <div ref={strip} className={`ptr ${phase}`} data-phase={phase} aria-live="polite" aria-hidden={phase === 'idle' || undefined}>
        <span ref={icon} className="pi" aria-hidden="true">
          <span ref={arrows} className="pr">
            <RefreshCw strokeWidth={2} />
          </span>
          <span className="pk">
            <Check strokeWidth={2.4} />
          </span>
          <span className="px">
            <X strokeWidth={2.4} />
          </span>
        </span>
        <span className="ptr-text">{phase === 'error' ? error : TEXT[phase]}</span>
      </div>
      {children}
    </div>
  )
}
