import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft } from '../ui/icons.ts'
import { useNav, useScreenActive } from './Navigator.tsx'

/*
 * iOS navigation bar (spec §6 «Назад как в iOS», «Компактная полоса навигации»): the «‹ Ещё» pill and an optional
 * trailing button, the large 32 pt title under it. The bar sticks to the top (below the iPhone notch); once the
 * large title has scrolled under it, the bar turns solid (--bar-bg, a crisp line) with a small centred title.
 */
export function NavBar({
  back,
  title,
  trailing,
  aside,
  leading,
  heading,
}: {
  back?: { label: string }
  /** the large title's text, and the small centred one once the large title has scrolled under the bar */
  title: string
  trailing?: ReactNode
  /** buttons on the large title's line, right-aligned (the calendar's ‹ ›) */
  aside?: ReactNode
  /** replaces the back pill on the bar's left (the report's «‹ Сентябрь») */
  leading?: ReactNode
  /** the large title's content when it is more than text (the category icon and name over «Расходы») */
  heading?: ReactNode
}) {
  const nav = useNav()
  const barRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [solid, setSolid] = useState(false)
  // a screen hidden under a deeper one keeps its look and listens to nothing
  const active = useScreenActive()

  useEffect(() => {
    if (!active) return
    // two rect reads per scroll event; React skips the render when the state does not change
    const sync = () => {
      const bar = barRef.current
      const h1 = titleRef.current
      if (bar && h1) setSolid(h1.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom)
    }
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [active])

  return (
    <>
      <div ref={barRef} className={`navbar stick${solid ? ' solid' : ''}`}>
        {leading ??
          (back ? (
            <button type="button" className="navback" aria-label={`Назад, ${back.label}`} onClick={nav.back}>
              <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
              {back.label}
            </button>
          ) : (
            <span />
          ))}
        {trailing ?? <span />}
        <span className="navtitle" aria-hidden="true">
          {title}
        </span>
      </div>
      {aside ? (
        <div className="titlerow">
          <h1 ref={titleRef} className="large" tabIndex={-1}>
            {heading ?? title}
          </h1>
          {aside}
        </div>
      ) : (
        <h1 ref={titleRef} className="large" tabIndex={-1}>
          {heading ?? title}
        </h1>
      )}
    </>
  )
}
