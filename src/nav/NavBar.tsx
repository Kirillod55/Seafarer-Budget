import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft } from '../ui/icons.ts'
import { useNav, useScreenActive } from './Navigator.tsx'

/*
 * iOS navigation bar (spec §6 «Назад как в iOS», «Компактная полоса навигации»): the «‹ Ещё» pill and an optional
 * trailing button, the large 32 pt title under it. The bar sticks to the top (below the iPhone notch); once the
 * large title has scrolled under it, the bar turns solid (--bar-bg, a crisp line) with a small centred title.
 */
export function NavBar({ back, title, trailing }: { back?: { label: string }; title: string; trailing?: ReactNode }) {
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
        {back ? (
          <button type="button" className="navback" aria-label={`Назад, ${back.label}`} onClick={nav.back}>
            <ChevronLeft aria-hidden="true" strokeWidth={2.4} />
            {back.label}
          </button>
        ) : (
          <span />
        )}
        {trailing ?? <span />}
        <span className="navtitle" aria-hidden="true">
          {title}
        </span>
      </div>
      <h1 ref={titleRef} className="large" tabIndex={-1}>
        {title}
      </h1>
    </>
  )
}
