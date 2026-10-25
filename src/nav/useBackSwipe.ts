import { useEffect, useRef, type RefObject } from 'react'
import { createTracker, project, rubber, spring } from '../ui/motion.ts'

/*
 * Swipe right = back, like on iPhone (spec §6 «Назад — свайпом вправо», «Второй проход»). The page follows the
 * finger with a shadow on its left, the previous page shows underneath sliding from −30 % to 0 under a fading scrim.
 * Released past 35 % of the width, or flicked so that Apple's projection lands past half — back, with no second
 * animation; otherwise a spring brings it home. The spring can be caught mid-flight.
 * Starts anywhere except on swipeable rows, fields and switches (from those only at the left 28 px edge);
 * vertical scrolling never starts it; off while the record sheet or a menu is open.
 */

/** Where a back swipe may not start (unless from the left edge): their own horizontal gestures live there. */
const OWN_GESTURES = '[data-swipe-row], input, select, textarea, [role="switch"], [role="slider"], .seg, [data-no-back-swipe]'
const EDGE = 28
const OVERLAYS = '[role="menu"], .glass, [aria-modal="true"]'
/**
 * The record sheet sets data-editing="1" on <html>; menus are role="menu" / .glass, modal sheets aria-modal — open
 * on the top screen or in a portal. Screens hidden under the top one do not count.
 */
function blocked(): boolean {
  if (document.documentElement.dataset.editing === '1') return true
  for (const m of document.querySelectorAll(OVERLAYS)) if (!m.closest('.screen.below')) return true
  return false
}

const MAX_V = 6000 // px/s: synthetic or glitchy touch samples must not fling the spring

export interface BackSwipeOptions {
  enabled: boolean
  /** The previous page (mounted, hidden under this one): revealed while dragging, moved with parallax. */
  underRef?: RefObject<HTMLElement | null>
  /** The layer between the two pages that dims the revealed one (opacity only). */
  scrimRef?: RefObject<HTMLElement | null>
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
      if (under) under.style.transform = `translateX(${-30 + 30 * p}%)`
      const scrim = o.current.scrimRef?.current
      if (scrim) scrim.style.opacity = String(0.6 * (1 - p))
    }
    const resetUnder = () => {
      const under = o.current.underRef?.current
      if (under) {
        under.classList.remove('peek')
        under.style.transform = ''
      }
      const scrim = o.current.scrimRef?.current
      if (scrim) scrim.style.opacity = ''
    }
    const release = () => {
      el.classList.remove('backdrag')
      el.style.transform = ''
      el.style.transition = ''
      resetUnder()
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
          // a push / tab animation still running would hold the page: stop it, the finger takes over
          for (const a of el.getAnimations?.() ?? []) a.cancel()
          el.classList.add('backdrag')
          el.style.transition = 'none'
          o.current.underRef?.current?.classList.add('peek')
          x0 = t.clientX // start from here, so the page does not jump by the 10 px dead zone
        }
      }
      if (mode !== 'back') return
      if (e.cancelable) e.preventDefault()
      tr.add(t.clientX)
      lastX = t.clientX
      const raw = t.clientX - x0
      place(raw < 0 ? -rubber(-raw, W) : raw)
    }

    /** Lift (touchend) decides by distance and speed; touchcancel always springs back. */
    const finish = (e: TouchEvent, cancelled: boolean) => {
      if (x0 === null) return
      x0 = null
      if (mode !== 'back') {
        mode = null
        return
      }
      mode = null
      // a finger held still before lifting has no speed left: sample the release moment too
      tr.add(e.changedTouches?.[0]?.clientX ?? lastX)
      const v = Math.max(-MAX_V, Math.min(MAX_V, tr.velocity()))
      const commit = !cancelled && v > -100 && (dx > W * 0.35 || dx + project(v) > W * 0.5)
      // Released while rubber-banded left of the edge: ease back from there; the clamp only stops an overshoot
      // once the page has reached the edge.
      let reached = dx >= 0
      sp = spring({
        from: dx,
        to: commit ? W : 0,
        velocity: v,
        damping: 1,
        response: 0.33,
        // never past the screen edge on the way home, nor beyond the width on the way out
        onUpdate: (x) => {
          if (x >= 0) reached = true
          place(Math.min(W, reached ? Math.max(0, x) : x))
        },
        onDone: () => {
          sp = null
          if (commit) {
            // Leave the revealed page as it is: the Navigator re-renders it as the top screen in one commit
            // (and clears the drag's leftovers there), so no frame shows it hidden behind an off-screen page.
            o.current.onCommit()
          } else {
            release()
          }
        },
      })
    }
    const end = (e: TouchEvent) => finish(e, false)
    const cancel = (e: TouchEvent) => finish(e, true)

    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', cancel)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', cancel)
      sp?.stop()
      if (el.isConnected) release()
    }
  }, [el, opts.enabled])
}
