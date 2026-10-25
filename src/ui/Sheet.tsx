import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { createTracker, prefersReducedMotion, project, rubber, spring } from './motion.ts'
import { lockScroll } from './scrollLock.ts'
import './sheet.css'

export interface SheetButton {
  label: string
  /** false (or a promise of false) keeps the sheet open — e.g. a field did not pass the check. */
  run?(): void | boolean | Promise<void | boolean>
  disabled?: boolean
}

export interface SheetHandle {
  /** Closes the sheet (then runs `after`); false when it is already closing — a second close is ignored. */
  close(after?: () => void): boolean
  /** The same as a tap on the right button (Enter in a field). */
  submit(): void
}

/** How long the closing slide takes (CSS .sheet.closing); the sheet is unmounted after it. */
const CLOSE_MS = 320
/** px/s: synthetic or glitchy touch samples must not fling the spring */
const MAX_V = 6000
/** A glass menu (Picker) is open: the sheet does not follow the finger. */
const menuOpen = () => !!document.querySelector('.glass:not(.out), .pick-catch')

/*
 * Bottom sheet (spec §6 «Новая/изменение записи — шторка снизу», «Шторку записи закрывают, потянув вниз из любой её
 * точки», «Шторка не трогает экран под ней», «Шторка записи не сохраняет дважды», «Второй проход»; prototype
 * openSheet/closeSheet/sheetDone/bindSheetDrag). A handle, «Отмена» on the left, the title, «Добавить/Готово» on
 * the right. Closes with a tap on the dimmed backdrop, Esc, or a pull down from anywhere in it — only a downward,
 * mostly vertical pull while its content is scrolled to the top; released below 28 % of its height (at most 140 px)
 * or flicked so that Apple's projection lands below 40 % — it slides away from where it is, otherwise a spring
 * brings it back; either spring can be caught mid-flight. A pull is never a tap on what is under the finger.
 * While it closes it takes no taps and a second close is ignored. While it is on screen the page under it is pinned
 * (lockScroll) and <html data-editing="1"> holds the app update back; both are undone when it has gone.
 * `open={false}` closes it the same way; `onClose` is called once, when it has fully gone (unmount it then).
 * It lives in a portal on <body> with aria-modal="true", so the back swipe stays off while it is open.
 */
export function Sheet({
  open = true,
  onClose,
  title,
  leading = { label: 'Отмена' },
  trailing,
  children,
  ref,
}: {
  open?: boolean
  onClose(): void
  title: string
  leading?: SheetButton
  trailing?: SheetButton
  children: ReactNode
  ref?: Ref<SheetHandle>
}) {
  const titleId = useId()
  const sheetRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  // all synchronous guards live in refs: two taps in one frame must see each other
  const closingRef = useRef(false)
  const busyRef = useRef(false)
  const finishedRef = useRef(false)
  const afterRef = useRef<(() => void) | undefined>(undefined)
  const springRef = useRef<{ stop(): void } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const releaseRef = useRef<(() => void) | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // the page under it pinned, the update gate held, focus moved in — from the first frame until it has gone
  useLayoutEffect(() => {
    const unlock = lockScroll()
    const html = document.documentElement
    html.dataset.editing = '1'
    let done = false
    const release = () => {
      if (done) return
      done = true
      unlock()
      delete html.dataset.editing
    }
    releaseRef.current = release
    const active = document.activeElement
    // (StrictMode runs this twice: the second time the focus is already inside)
    if (active instanceof HTMLElement && !sheetRef.current?.contains(active)) returnFocus.current = active
    sheetRef.current?.focus({ preventScroll: true })
    return () => {
      release()
      springRef.current?.stop()
      clearTimeout(timerRef.current)
    }
  }, [])

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    springRef.current = null
    releaseRef.current?.()
    const back = returnFocus.current
    if (back?.isConnected && !back.closest('[inert]')) back.focus({ preventScroll: true })
    afterRef.current?.()
    onCloseRef.current()
  }, [])

  const close = useCallback(
    (after?: () => void): boolean => {
      if (closingRef.current) return false
      closingRef.current = true
      afterRef.current = after
      springRef.current?.stop()
      springRef.current = null
      if (prefersReducedMotion()) {
        finish()
        return true
      }
      // after a pull the inline `animation: none` would hide the .closing slide: set it here, from where it is
      const sh = sheetRef.current
      const bd = backdropRef.current
      if (sh) sh.style.animation = `sheetDown ${CLOSE_MS}ms var(--ios) forwards`
      if (bd) bd.style.animation = `sheetFadeOut ${CLOSE_MS}ms var(--ios) forwards`
      setClosing(true)
      timerRef.current = setTimeout(finish, CLOSE_MS)
      return true
    },
    [finish],
  )

  const press = useCallback(
    async (b: SheetButton | undefined) => {
      if (!b || b.disabled || closingRef.current || busyRef.current) return
      busyRef.current = true
      let keep = false
      try {
        keep = (await b.run?.()) === false
      } catch {
        keep = true
      } finally {
        busyRef.current = false
      }
      if (!keep) close()
    },
    [close],
  )

  const trailingRef = useRef(trailing)
  trailingRef.current = trailing
  useImperativeHandle(ref, () => ({ close, submit: () => void press(trailingRef.current) }), [close, press])

  // open={false} from outside (navigation): close the same way
  useEffect(() => {
    if (!open) close()
  }, [open, close])

  // the keyboard: keep the sheet above it and inside the visible part of the screen
  useEffect(() => {
    const vv = window.visualViewport
    const sh = sheetRef.current
    if (!vv || !sh) return
    const fit = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      sh.style.setProperty('--kb', `${kb}px`)
      sh.style.setProperty('--vvh', `${vv.height}px`)
      const f = document.activeElement
      if (kb > 0 && f instanceof HTMLElement && sh.contains(f) && f !== sh) f.scrollIntoView({ block: 'nearest' })
    }
    fit()
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    return () => {
      vv.removeEventListener('resize', fit)
      vv.removeEventListener('scroll', fit)
    }
  }, [])

  // pull down to close, from any point of the sheet
  useEffect(() => {
    const sh = sheetRef.current
    const bd = backdropRef.current
    if (!sh || !bd) return
    const tr = createTracker()
    let y = 0 // where the sheet is now (px below its open place)
    let y0: number | null = null
    let x0 = 0
    let lastY = 0
    let mode: 'drag' | 'none' | null = null
    let dragClose = false

    const place = (v: number) => {
      y = v
      sh.style.transform = `translateY(${v}px)`
      bd.style.opacity = String(Math.max(0.15, 1 - Math.max(0, v) / (sh.offsetHeight || 1)))
    }
    const settle = () => {
      y = 0
      sh.style.transform = ''
      sh.style.transition = ''
      bd.style.opacity = ''
      bd.style.transition = ''
    }
    const grab = () => {
      sh.style.animation = 'none'
      sh.style.transition = 'none'
      bd.style.animation = 'none'
      bd.style.transition = 'none'
      sh.classList.add('dragging')
    }

    const start = (x: number, py: number) => {
      if (finishedRef.current || menuOpen()) return
      if (closingRef.current && !dragClose) return // closing by a button: no catching
      tr.reset()
      tr.add(py)
      lastY = py
      if (springRef.current) {
        // caught mid-flight: carry on from where it is (a closing pull is called off)
        springRef.current.stop()
        springRef.current = null
        if (dragClose) {
          dragClose = false
          closingRef.current = false
        }
        mode = 'drag'
        y0 = py - y
        x0 = x
        grab()
        return
      }
      y0 = py
      x0 = x
      mode = null
    }

    const move = (x: number, py: number, e: Event) => {
      if (y0 === null) return
      if (mode === null) {
        const dy = py - y0
        const dx = x - x0
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return
        // only a downward, mostly vertical pull while the content is scrolled to its top
        mode = dy > 0 && Math.abs(dy) > Math.abs(dx) && sh.scrollTop <= 0 ? 'drag' : 'none'
        if (mode === 'drag') {
          y0 = py // from here, so the sheet does not jump by the dead zone
          grab()
          const f = document.activeElement
          if (f instanceof HTMLElement && f !== sh && sh.contains(f)) f.blur()
        }
      }
      if (mode !== 'drag') return
      if (e.cancelable) e.preventDefault()
      tr.add(py)
      lastY = py
      const raw = py - y0
      place(raw < 0 ? -rubber(-raw, sh.offsetHeight || 1) : raw)
    }

    const end = (cancelled: boolean) => {
      if (y0 === null) return
      const was = mode
      y0 = null
      mode = null
      if (was !== 'drag') return
      sh.classList.remove('dragging')
      // a pull must not also count as a tap on the button or category under the finger
      const block = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      sh.addEventListener('click', block, true)
      setTimeout(() => sh.removeEventListener('click', block, true), 60)

      tr.add(lastY)
      const v = Math.max(-MAX_V, Math.min(MAX_V, tr.velocity()))
      const H = sh.offsetHeight || 1
      const rest = y + project(v)
      if (!cancelled && v > -150 && (rest > H * 0.4 || y > Math.min(140, H * 0.28))) {
        dragClose = true
        closingRef.current = true
        afterRef.current = undefined
        springRef.current = spring({
          from: y,
          to: H + 30,
          velocity: v,
          damping: 1,
          response: 0.32,
          onUpdate: place,
          onDone: finish,
        })
      } else {
        springRef.current = spring({
          from: y,
          to: 0,
          velocity: v,
          damping: 0.8,
          response: 0.3,
          onUpdate: place,
          onDone: () => {
            springRef.current = null
            settle()
          },
        })
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY)
      else y0 = null
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t) move(t.clientX, t.clientY, e)
    }
    const onTouchEnd = () => end(false)
    const onTouchCancel = () => end(true)
    const isMouse = (e: PointerEvent) => e.pointerType === 'mouse'
    const onPointerDown = (e: PointerEvent) => {
      if (isMouse(e) && e.button === 0) start(e.clientX, e.clientY)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (isMouse(e)) move(e.clientX, e.clientY, e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (isMouse(e)) end(false)
    }

    sh.addEventListener('touchstart', onTouchStart, { passive: true })
    sh.addEventListener('touchmove', onTouchMove, { passive: false })
    sh.addEventListener('touchend', onTouchEnd)
    sh.addEventListener('touchcancel', onTouchCancel)
    sh.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      sh.removeEventListener('touchstart', onTouchStart)
      sh.removeEventListener('touchmove', onTouchMove)
      sh.removeEventListener('touchend', onTouchEnd)
      sh.removeEventListener('touchcancel', onTouchCancel)
      sh.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [finish])

  const cls = closing ? ' closing' : ''
  return createPortal(
    <>
      <div
        ref={backdropRef}
        className={`backdrop${cls}`}
        aria-hidden="true"
        onClick={() => {
          if (!springRef.current) close()
        }}
      />
      <div
        ref={sheetRef}
        className={`sheet${cls}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          // a menu inside handles its own Esc (and marks it handled)
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            close()
          }
        }}
      >
        <div className="grab" aria-hidden="true">
          <span />
        </div>
        <div className="sheetnav">
          <button type="button" className="navbtn" onClick={() => void press(leading)}>
            {leading.label}
          </button>
          <h3 id={titleId}>{title}</h3>
          {trailing ? (
            <button type="button" className="navbtn strong" disabled={trailing.disabled} onClick={() => void press(trailing)}>
              {trailing.label}
            </button>
          ) : (
            <span />
          )}
        </div>
        {children}
      </div>
    </>,
    document.body,
  )
}
