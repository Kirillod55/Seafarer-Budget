import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { prefersReducedMotion } from './motion.ts'
import './ui.css'

/*
 * Swap a block's content in place (spec §6 «Плавная перерисовка»; prototype morph()): when `k` changes, the old
 * content fades out on top (0.16 s), the new one fades in (0.3 s), the block's height glides (0.34 s) — nothing
 * else on the page jumps. The old layer is the same React subtree (same key), kept as an inert, hidden copy until
 * the animation ends. Reduce Motion (or no Web Animations): an instant swap.
 * With `dir` (the calendar's day card, spec §3 «Смена дня без перерисовки страницы») the swap is sideways: the old
 * content leaves towards −dir with its opacity (0.17 s), the new one rides in from +dir (0.32 s), the height glides
 * (0.32 s). A swap during a swap starts from what is on screen — animations never pile up.
 */
export function Morph({
  k,
  children,
  className,
  dir,
}: {
  k: string | number
  children: ReactNode
  className?: string
  /** 1 = the new content comes from the right, −1 = from the left; unset = the default fade */
  dir?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  // `gen` counts the swaps: each content gets its own React key, so going back to an earlier `k` mounts it afresh
  const [seen, setSeen] = useState({ k, gen: 0 })
  const last = useRef<{ gen: number; node: ReactNode }>({ gen: 0, node: children })
  const [ghost, setGhost] = useState<{ gen: number; node: ReactNode; h0: number; dir?: number } | null>(null)

  if (seen.k !== k) {
    setSeen({ k, gen: seen.gen + 1 })
    const el = box.current
    const animated = !!el && !prefersReducedMotion() && typeof el.animate === 'function'
    // the last committed content becomes the leaving layer
    setGhost(animated ? { ...last.current, h0: el.offsetHeight, dir } : null)
  }

  useLayoutEffect(() => {
    last.current = { gen: seen.gen, node: children }
  })

  useLayoutEffect(() => {
    const el = box.current
    if (!ghost || !el) return
    const old = el.querySelector<HTMLElement>(':scope > .mOld')
    const cur = el.querySelector<HTMLElement>(':scope > .mIn:not(.mOld)')
    if (!old || !cur) return
    // the old copy must not clash with the new content (labels, anchors)
    old.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'))
    el.style.overflow = 'clip'
    const ease = 'cubic-bezier(.2,.8,.2,1)'
    const d = ghost.dir
    const anims = d
      ? [
          el.animate([{ height: `${ghost.h0}px` }, { height: `${cur.offsetHeight}px` }], { duration: 320, easing: ease }),
          old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-d * 18}px)` }], {
            duration: 170,
            easing: 'ease-in',
            fill: 'forwards',
          }),
          cur.animate([{ opacity: 0, transform: `translateX(${d * 22}px)` }, { opacity: 1, transform: 'none' }], {
            duration: 320,
            delay: 50,
            easing: ease,
            fill: 'backwards',
          }),
        ]
      : [
          el.animate([{ height: `${ghost.h0}px` }, { height: `${cur.offsetHeight}px` }], { duration: 340, easing: ease }),
          old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' }),
          cur.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], {
            duration: 300,
            delay: 60,
            easing: ease,
            fill: 'backwards',
          }),
        ]
    let done = false
    const finish = () => {
      if (done) return
      done = true
      anims.forEach((a) => a.cancel())
      el.style.overflow = ''
      setGhost((g) => (g === ghost ? null : g))
    }
    anims[0].onfinish = finish
    const t = setTimeout(finish, 420)
    return () => {
      clearTimeout(t)
      if (!done) {
        done = true
        anims.forEach((a) => a.cancel())
        el.style.overflow = ''
      }
    }
  }, [ghost])

  return (
    <div ref={box} className={`morph${className ? ` ${className}` : ''}`}>
      {ghost && (
        <div key={`m-${ghost.gen}`} className="mIn mOld" aria-hidden="true" inert>
          {ghost.node}
        </div>
      )}
      <div key={`m-${seen.gen}`} className="mIn">
        {children}
      </div>
    </div>
  )
}
