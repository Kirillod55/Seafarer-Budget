import { useEffect, useRef, type RefObject } from 'react'
import { createTracker, project, rubber, spring } from '../ui/motion.ts'

/*
 * Swipe right = back, like on iPhone (spec §6 «Назад — свайпом вправо», «Второй проход»). The page follows the
 * finger with a shadow on its left, the previous page shows underneath sliding from −30 % to 0 with a fading dim.
 * Released past 35 % of the width, or flicked so that Apple's projection lands past half — back, with no second
 * animation; otherwise a spring brings it home. The spring can be caught mid-flight.
 * Starts anywhere except on swipeable rows, fields and switches (from those only at the left 28 px edge);
 * vertical scrolling never starts it; off while the record sheet or a menu is open.
 */

/** Where a back swipe may not start (unless from the left edge): their own horizontal gestures live there. */
const OWN_GESTURES = '[data-swipe-row], input, select, textarea, [role="switch"], [role="slider"], .seg, [data-no-back-swipe]'
const EDGE = 28
/** The record sheet sets data-editing="1" on <html>; menus are role="menu" / .glass, modal sheets aria-modal. */
function blocked(): boolean {
  return (
    document.documentElement.dataset.editing === '1' ||
    document.querySelector('[role="menu"], .glass, [aria-modal="true"]') !== null
  )
}

const MAX_V = 6000 // px/s: synthetic or glitchy touch samples must not fling the spring

export interface BackSwipeOptions {
  enabled: boolean
  /** The layer with the previous page (rendered after onStart); moved with parallax and dimmed. */
  underRef?: RefObject<HTMLElement | null>
  onStart?(): void
  onCancel?(): void
  /** The page has slid fully off: navigate back without another transition. */
  onCommit(): void
}

export function useBackSwipe(el: HTMLElement | null, opts: BackSwipeOptions): void {
  const o = useRef(opts)
  o.current = opts

  useEffect(() => {
    if (!el || !opts.enabled) return
    const tr = createTracker()
    let x0: number | null = null
    let y0 = 0
    let dx = 0
    let mode: 'back' | 'none' | null = null
    let W = 0
    let sp: { stop(): void } | null = null
    let lastX = 0

    const place = (x: number) => {
      dx = x
      const p = Math.max(0, Math.min(1, x / W))
      el.style.transform = `translateX(${x}px)`
      const under = o.current.underRef?.current
      if (under) {
        under.style.transform = `translateX(${-30 + 30 * p}%)`
        under.style.setProperty('--dim', String(0.18 * (1 - p)))
      }
    }
    const release = () => {
      el.classList.remove('backdrag')
      el.style.transform = ''
      el.style.transition = ''
    }

    const start = (e: TouchEvent) => {
      if (!o.current.enabled || blocked() || e.touches.length !== 1) return
      const t = e.touches[0]
      tr.reset()
      tr.add(t.clientX)
      lastX = t.clientX
      if (sp) {
        // caught mid-flight: carry on from where the page is
        sp.stop()
        sp = null
        mode = 'back'
        x0 = t.clientX - dx
        y0 = t.clientY
        return
      }
      const fromEdge = t.clientX < EDGE
      const target = e.target instanceof Element ? e.target : null
      if (!fromEdge && target?.closest(OWN_GESTURES)) return
      x0 = t.clientX
      y0 = t.clientY
      dx = 0
      mode = null
    }

    const move = (e: TouchEvent) => {
      if (x0 === null) return
      const t = e.touches[0]
      if (!t) return
      const mx = t.clientX - x0
      const my = t.clientY - y0
      if (mode === null) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return
        mode = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2 ? 'back' : 'none'
        if (mode === 'back') {
          W = el.getBoundingClientRect().width || window.innerWidth
          el.classList.add('backdrag')
          el.style.transition = 'none'
          x0 = t.clientX // start from here, so the page does not jump by the 10 px dead zone
          o.current.onStart?.()
        }
      }
      if (mode !== 'back') return
      if (e.cancelable) e.preventDefault()
      tr.add(t.clientX)
      lastX = t.clientX
      const raw = t.clientX - x0
      place(raw < 0 ? -rubber(-raw, W) : raw)
    }

    const end = () => {
      if (x0 === null) return
      x0 = null
      if (mode !== 'back') {
        mode = null
        return
      }
      mode = null
      // a finger held still before lifting has no speed left: sample the release moment too
      tr.add(lastX)
      const v = Math.max(-MAX_V, Math.min(MAX_V, tr.velocity()))
      const commit = v > -100 && (dx > W * 0.35 || dx + project(v) > W * 0.5)
      sp = spring({
        from: dx,
        to: commit ? W : 0,
        velocity: v,
        damping: 1,
        response: 0.33,
        onUpdate: place,
        onDone: () => {
          sp = null
          if (commit) {
            o.current.onCommit()
          } else {
            release()
            o.current.onCancel?.()
          }
        },
      })
    }

    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      sp?.stop()
      if (el.isConnected) release()
    }
  }, [el, opts.enabled])
}
