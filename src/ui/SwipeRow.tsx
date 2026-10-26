import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createTracker, prefersReducedMotion, project, rubber, spring } from './motion.ts'
import './ui.css'

export interface SwipeAction {
  key: 'edit' | 'archive' | 'delete'
  label: string
  run(): void
}

/*
 * A list row that swipes left to show its actions (spec §6 «Второй проход»: «Строки трат и категорий»; prototype
 * bindSwipes / closeRow / collapseRow). The buttons sit behind the row — 3 × 74 px, or 2 × 84 px with two actions —
 * and are hidden (also from screen readers) until the row is pulled. Past the open position the row keeps
 * following the finger; to the right and past the full width it resists softly. On release a spring takes it from
 * where it is, with the finger's speed, to open or closed, chosen by where the flick would land (projection 0.99).
 * A swipe further than «open + 40 px» and over 60 % of the width deletes, like Mail on the iPhone: the other buttons
 * fold away, the red one fills the row, the row slides off, collapses, and the delete action runs. Archive and
 * delete collapse the row first; «Изменить» closes it. Tapping an open (or opening) row, or any row while one is
 * open, only closes it. Only one row is open at a time. The root carries `data-swipe-row`, so the back swipe
 * leaves it alone.
 *
 * Moving rows: a running spring is stopped only when a new drag actually starts (the row is caught on the fly);
 * a plain tap never freezes it. While the row slides off or collapses it takes no input at all.
 * Keyboard: ArrowLeft or the context-menu key opens the row and focuses the first action; Esc (or ArrowRight on
 * the row) closes it and returns focus to the row.
 */

/** px/s: synthetic or glitchy samples must not fling the spring (as the back swipe) */
const MAX_V = 6000
/** collapse of the row before archive / delete (CSS .swipe.collapse is 0.3 s) */
const COLLAPSE_MS = 280
/** if the row is still here this long after its action ran (it was not removed), it comes back */
const RESTORE_MS = 1200

/** the one open (or opening) row on the page */
let openRow: { close(): void } | null = null

/** Closes the open swipe row, if any; true when one was open (a tap on a plain row then only closes it). */
export function closeOpenSwipeRow(): boolean {
  if (!openRow) return false
  openRow.close()
  return true
}

/**
 * Focus the next row of the same list (or the previous one); with no other row, the list itself (made focusable
 * for this). The list is the nearest `.days` (DayGroups) or else the row's parent.
 */
function focusNeighbour(root: HTMLElement) {
  const list = root.closest<HTMLElement>('.days') ?? root.parentElement
  if (!list) return
  const rows = [...list.querySelectorAll<HTMLElement>('[data-swipe-row]:not(.collapse)')]
  const i = rows.indexOf(root)
  const to = rows[i + 1] ?? rows[i - 1]
  const fg = to && to !== root ? to.querySelector<HTMLElement>('.tx') : null
  if (fg) {
    fg.focus()
    return
  }
  if (!list.hasAttribute('tabindex')) list.tabIndex = -1
  list.focus()
}

export function SwipeRow({
  actions,
  onOpen,
  children,
  className = '',
}: {
  actions: SwipeAction[]
  onOpen(): void
  children: ReactNode
  /** extra classes on the root (e.g. `row-in` for a row that has just appeared) */
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<HTMLButtonElement>(null)
  const actsRef = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)
  const [full, setFull] = useState(false)
  const [collapsing, setCollapsing] = useState(false)

  const n = actions.length
  const open = n * (n > 2 ? 74 : 84)
  const canFull = actions.some((a) => a.key === 'delete')

  // gesture state lives in refs: the row moves every frame without re-rendering
  const [g] = useState(() => ({
    x: 0,
    /** the finger this gesture follows; a second finger is ignored */
    pid: null as number | null,
    x0: null as number | null,
    y0: 0,
    base: 0,
    drag: false,
    /** a mouse drag just ended: the click it sends is not a tap */
    dragged: false,
    full: false,
    /** sliding off after a full swipe, or collapsing: no input until it is gone */
    leaving: false,
    /** focus the first action once the buttons are shown (keyboard open) */
    focusFirst: false,
    sp: null as { stop(): void } | null,
    tracker: createTracker(),
    timers: [] as ReturnType<typeof setTimeout>[],
  }))
  const [me] = useState<{ close(): void }>(() => ({ close: () => {} }))

  const width = () => rootRef.current?.offsetWidth || 0

  const place = (x: number) => {
    g.x = x
    if (fgRef.current) fgRef.current.style.transform = `translateX(${x}px)`
    if (actsRef.current) actsRef.current.style.width = `${Math.max(open, -x)}px`
  }

  const setFullOnce = (v: boolean) => {
    if (g.full === v) return
    g.full = v
    setFull(v)
  }

  /** back to rest at 0: the buttons hide again once the row is closed */
  const settle = () => {
    if (openRow === me) openRow = null
    setRevealed(false)
    setFullOnce(false)
    if (actsRef.current) actsRef.current.style.width = ''
  }

  const springTo = (target: number, velocity: number, damping: number, response: number, done?: () => void) => {
    g.sp?.stop()
    g.sp = spring({
      from: g.x,
      to: target,
      velocity,
      damping,
      response,
      onUpdate: place,
      onDone: () => {
        g.sp = null
        done?.()
      },
    })
  }

  me.close = () => {
    if (g.leaving) return
    if (openRow === me) openRow = null
    springTo(0, 0, 1, 0.3, settle)
  }

  /** open to the buttons; the open row is known at once, not when the spring lands */
  const openTo = (velocity: number, damping: number) => {
    if (openRow && openRow !== me) openRow.close()
    openRow = me
    setRevealed(true)
    springTo(-open, velocity, damping, 0.3)
  }

  const run = (a: SwipeAction) => {
    if (g.leaving) return
    if (a.key === 'edit') {
      me.close()
      a.run()
      return
    }
    if (openRow === me) openRow = null
    g.leaving = true
    g.pid = null
    g.x0 = null
    const root = rootRef.current
    // keyboard («В архив» / «Удалить» with Enter): focus must not fall to <body> when this row goes
    if (root?.contains(document.activeElement)) focusNeighbour(root)
    const later = () => {
      try {
        a.run()
      } catch (err) {
        // a failing action must not leave the row collapsed and deaf: it comes back below
        console.error('SwipeRow: action failed', err)
      } finally {
        // the action normally takes the row off the list; if it is still here, show it again
        g.timers.push(
          setTimeout(() => {
            g.leaving = false
            setCollapsing(false)
            if (rootRef.current) rootRef.current.style.height = ''
            g.sp?.stop()
            g.sp = null
            place(0)
            settle()
          }, RESTORE_MS),
        )
      }
    }
    if (!root || prefersReducedMotion()) {
      later()
      return
    }
    root.style.height = `${root.offsetHeight}px`
    setCollapsing(true)
    g.timers.push(setTimeout(later, COLLAPSE_MS))
  }

  // collapse: from the row's height (set above) to 0 once the transition class is on
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!collapsing || !root) return
    void root.offsetHeight
    root.style.height = '0px'
  }, [collapsing])

  // keyboard open: the first action takes focus once the buttons are no longer inert
  useEffect(() => {
    if (!revealed || !g.focusFirst) return
    g.focusFirst = false
    actsRef.current?.querySelector<HTMLButtonElement>('.act')?.focus()
  }, [revealed, g])

  useEffect(
    () => () => {
      g.sp?.stop()
      g.timers.forEach(clearTimeout)
      if (openRow === me) openRow = null
    },
    [g, me],
  )

  const down = (e: ReactPointerEvent) => {
    // a second finger is ignored; the same pointer going down again (a mouse is always one id) starts afresh
    if (g.leaving || (g.pid !== null && g.pid !== e.pointerId) || (e.pointerType === 'mouse' && e.button !== 0)) return
    g.pid = e.pointerId
    g.x0 = e.clientX
    g.y0 = e.clientY
    g.drag = false
    g.dragged = false
    g.tracker.reset()
    g.tracker.add(e.clientX)
    // a running spring keeps going: only a real drag catches the row (move)
  }

  const move = (e: ReactPointerEvent) => {
    if (e.pointerId !== g.pid || g.x0 === null || g.leaving) return
    const mx = e.clientX - g.x0
    const my = e.clientY - g.y0
    g.tracker.add(e.clientX)
    if (!g.drag) {
      if (Math.abs(my) > 8 && Math.abs(my) >= Math.abs(mx)) {
        // scrolling: this gesture is not a swipe
        g.x0 = null
        return
      }
      if (Math.abs(mx) <= 8) return
      g.drag = true
      // catch the row where it is now, on the fly; from here it follows the finger from where it went down
      // (the few px of slop included, as the prototype and UIKit pans do)
      g.sp?.stop()
      g.sp = null
      g.base = g.x
      try {
        fgRef.current?.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer */
      }
      setRevealed(true)
      if (openRow && openRow !== me) openRow.close()
    }
    const raw = g.base + mx
    const w = width()
    const x = raw > 0 ? rubber(raw, w) : raw < -w ? -w - rubber(-raw - w, w) : raw
    place(x)
    setFullOnce(canFull && -raw > Math.max(w * 0.6, open + 40))
  }

  const up = (e: ReactPointerEvent, cancelled: boolean) => {
    if (e.pointerId !== g.pid) return
    g.pid = null
    const started = g.x0 !== null && g.drag
    g.x0 = null
    if (!started || g.leaving) return
    g.drag = false
    // only a mouse sends a click at the end of a drag; a touch drag does not, and a keyboard click is never one
    g.dragged = e.pointerType === 'mouse'
    const v = Math.max(-MAX_V, Math.min(MAX_V, g.tracker.velocity()))
    const w = width()
    if (g.full && !cancelled) {
      // full swipe: the row slides all the way, then the delete action runs (with «Отменить»)
      const del = actions.find((a) => a.key === 'delete')!
      if (openRow === me) openRow = null
      g.leaving = true
      springTo(-w, v, 1, 0.25, () => {
        g.leaving = false
        run(del)
      })
      return
    }
    setFullOnce(false)
    const rest = g.x + project(v, 0.99)
    const target = v > 300 ? 0 : v < -300 || rest < -open / 2 ? -open : 0
    if (target) openTo(v, Math.abs(v) > 600 ? 0.8 : 1)
    else {
      if (openRow === me) openRow = null
      springTo(0, v, 1, 0.3, settle)
    }
  }

  /** the pointer left the row before any drag began (a mouse pressed, then moved off): forget it */
  const leave = (e: ReactPointerEvent) => {
    if (e.pointerId !== g.pid || g.drag) return
    g.pid = null
    g.x0 = null
  }

  const click = (e: ReactMouseEvent) => {
    if (g.leaving) return
    if (g.dragged) {
      g.dragged = false
      // the click a mouse sends at the end of its drag is not a tap (a keyboard click has detail 0)
      if (e.detail !== 0) return
    }
    if (openRow) {
      openRow.close()
      return
    }
    // still springing back to rest: let it land rather than open the record mid-way
    if (g.sp) return
    onOpen()
  }

  const keyDown = (e: ReactKeyboardEvent) => {
    if (g.leaving) return
    const onRow = e.target === fgRef.current
    if (onRow && (e.key === 'ArrowLeft' || e.key === 'ContextMenu')) {
      e.preventDefault()
      // buttons already shown: focus now; otherwise once they stop being inert (effect above)
      if (revealed) actsRef.current?.querySelector<HTMLButtonElement>('.act')?.focus()
      else g.focusFirst = true
      openTo(0, 1)
      return
    }
    if (e.key === 'Escape' || (onRow && e.key === 'ArrowRight')) {
      if (openRow !== me && !revealed) return
      e.preventDefault()
      e.stopPropagation()
      me.close()
      fgRef.current?.focus()
    }
  }

  const cls = ['swipe', revealed && 'swiping', full && 'full', collapsing && 'collapse', className].filter(Boolean).join(' ')

  return (
    <div ref={rootRef} className={cls} data-swipe-row="" onKeyDown={keyDown}>
      <div ref={actsRef} className={`acts n${n}`} aria-hidden={!revealed} inert={!revealed}>
        {actions.map((a) => (
          <button key={a.key} type="button" className={`act ${a.key}`} tabIndex={revealed ? 0 : -1} onClick={() => run(a)}>
            {a.label}
          </button>
        ))}
      </div>
      <button
        ref={fgRef}
        type="button"
        className="tx"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => up(e, false)}
        onPointerCancel={(e) => up(e, true)}
        onPointerLeave={leave}
        // capture lost without a pointerup reaching the row (after a normal up the pointer is already forgotten)
        onLostPointerCapture={(e) => up(e, true)}
        onClick={click}
      >
        {children}
      </button>
    </div>
  )
}
