import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
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
 * delete collapse the row first; «Изменить» closes it. Tapping an open row (or any row while one is open) only
 * closes it. Only one row is open at a time. The root carries `data-swipe-row`, so the back swipe leaves it alone.
 */

/** px/s: synthetic or glitchy samples must not fling the spring (as the back swipe) */
const MAX_V = 6000
/** collapse of the row before archive / delete (CSS .swipe.collapse is 0.3 s) */
const COLLAPSE_MS = 280
/** if the row is still here this long after its action ran (it was not removed), it comes back */
const RESTORE_MS = 1200

/** the one open row on the page */
let openRow: { close(): void } | null = null

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
    x0: null as number | null,
    y0: 0,
    base: 0,
    drag: false,
    dragged: false,
    full: false,
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

  const springTo = (target: number, velocity: number, damping: number, response: number, done: () => void) => {
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
        done()
      },
    })
  }

  me.close = () => {
    if (openRow === me) openRow = null
    springTo(0, 0, 1, 0.3, settle)
  }

  const run = (a: SwipeAction) => {
    if (a.key === 'edit') {
      me.close()
      a.run()
      return
    }
    if (openRow === me) openRow = null
    const root = rootRef.current
    const later = () => {
      a.run()
      // the action normally takes the row off the list; if it is still here, show it again
      g.timers.push(
        setTimeout(() => {
          setCollapsing(false)
          if (rootRef.current) rootRef.current.style.height = ''
          g.sp?.stop()
          place(0)
          settle()
        }, RESTORE_MS),
      )
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

  useEffect(
    () => () => {
      g.sp?.stop()
      g.timers.forEach(clearTimeout)
      if (openRow === me) openRow = null
    },
    [g, me],
  )

  const down = (e: ReactPointerEvent) => {
    if (collapsing || (e.pointerType === 'mouse' && e.button !== 0)) return
    g.x0 = e.clientX
    g.y0 = e.clientY
    g.drag = false
    g.dragged = false
    g.tracker.reset()
    g.tracker.add(e.clientX)
    // catch a moving row on the fly
    g.sp?.stop()
    g.sp = null
    g.base = g.x
  }

  const move = (e: ReactPointerEvent) => {
    if (g.x0 === null) return
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

  const up = (cancelled: boolean) => {
    if (g.x0 === null) return
    g.x0 = null
    if (!g.drag) return
    g.drag = false
    g.dragged = true
    const v = Math.max(-MAX_V, Math.min(MAX_V, g.tracker.velocity()))
    const w = width()
    if (g.full && !cancelled) {
      // full swipe: the row slides all the way, then the delete action runs (with «Отменить»)
      const del = actions.find((a) => a.key === 'delete')!
      springTo(-w, v, 1, 0.25, () => run(del))
      return
    }
    setFullOnce(false)
    const rest = g.x + project(v, 0.99)
    const target = v > 300 ? 0 : v < -300 || rest < -open / 2 ? -open : 0
    springTo(target, v, target && Math.abs(v) > 600 ? 0.8 : 1, 0.3, () => {
      if (target) openRow = me
      else settle()
    })
  }

  const click = () => {
    if (g.dragged) {
      // the click that ends a drag is not a tap
      g.dragged = false
      return
    }
    if (openRow) {
      openRow.close()
      return
    }
    onOpen()
  }

  const cls = ['swipe', revealed && 'swiping', full && 'full', collapsing && 'collapse', className].filter(Boolean).join(' ')

  return (
    <div ref={rootRef} className={cls} data-swipe-row="">
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
        onPointerUp={() => up(false)}
        onPointerCancel={() => up(true)}
        onClick={click}
      >
        {children}
      </button>
    </div>
  )
}
