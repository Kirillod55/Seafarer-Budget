import { useLayoutEffect, useRef } from 'react'
import { prefersReducedMotion } from './motion.ts'
import './ui.css'

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

/*
 * Segmented switch (spec §6 «Переключатели-сегменты»; prototype segSelect/placeThumb): the lime pill glides under
 * the chosen item (0.45 s, --ios). It is placed without animation when the switch first appears, on resize and
 * with Reduce Motion; afterwards each change slides it from where it was.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentOption<T>[]
  value: T
  onChange(v: T): void
  /** Accessible name of the group («Тип записи», «Тема»). */
  label: string
}) {
  const segRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)
  const index = options.findIndex((o) => o.value === value)
  const indexRef = useRef(index)
  indexRef.current = index

  const place = (i: number, instant: boolean) => {
    const seg = segRef.current
    const th = thumbRef.current
    if (!seg || !th) return
    const b = seg.querySelectorAll<HTMLButtonElement>(':scope > button')[i]
    if (!b) {
      th.style.opacity = '0'
      return
    }
    th.style.opacity = ''
    if (instant) th.style.transition = 'none'
    th.style.width = `${b.offsetWidth}px`
    th.style.transform = `translateX(${b.offsetLeft}px)`
    if (instant) {
      void th.offsetWidth // commit the jump before the transition comes back
      th.style.transition = ''
    }
  }

  // a new choice: slide (the first placement, and Reduce Motion, jump)
  useLayoutEffect(() => {
    place(index, !placed.current || prefersReducedMotion())
    placed.current = true
  }, [index, options.length])

  // widths change with the window, the font loading and Dynamic Type: follow them without a slide
  useLayoutEffect(() => {
    const seg = segRef.current
    if (!seg) return
    // only a real change of the switch's width re-places the pill at once: a height change around it (a form below
    // gliding to its new height, a scrollbar flickering in during that) must not cut the pill's slide short
    let width = seg.offsetWidth
    const again = () => {
      if (seg.offsetWidth === width) return
      width = seg.offsetWidth
      place(indexRef.current, true)
    }
    window.addEventListener('resize', again)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null
    ro?.observe(seg)
    return () => {
      window.removeEventListener('resize', again)
      ro?.disconnect()
    }
  }, [])

  return (
    <div ref={segRef} className="seg" role="group" aria-label={label}>
      <span ref={thumbRef} className="thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
