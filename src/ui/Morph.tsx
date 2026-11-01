import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { prefersReducedMotion } from './motion.ts'
import './ui.css'

/*
 * Swap a block's content in place (spec §6 «Плавная перерисовка»; prototype morph()): when `k` changes, the old
 * content fades out on top (0.16 s), the new one fades in (0.3 s), the block's height glides (0.34 s) — nothing
 * else on the page jumps. The old layer is the same React subtree (same key), kept as an inert, hidden copy until
 * the animation ends. Reduce Motion (or no Web Animations): an instant swap.
 * With `fade` (the calendar's day card, spec §3 «Смена дня без перерисовки страницы») nothing moves: the old and the
 * new content cross-fade in place (0.18 s), so the same words stay where they are and only what differs changes. The
 * block keeps its old height and takes the new one when the swap ends: no frame of it lays the page out. A swap during
 * a swap starts from the opacity on screen, so quick taps never flash.
 */
export function Morph({
  k,
  children,
  className,
  fade,
}: {
  k: string | number
  children: ReactNode
  className?: string
  /** an opacity-only cross-fade in place; unset = the default swap */
  fade?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  // `gen` counts the swaps: each content gets its own React key, so going back to an earlier `k` mounts it afresh
  const [seen, setSeen] = useState({ k, gen: 0 })
  const last = useRef<{ gen: number; node: ReactNode }>({ gen: 0, node: children })
  const [ghost, setGhost] = useState<{ gen: number; node: ReactNode; h0: number; o0: number } | null>(null)

  if (seen.k !== k) {
    setSeen({ k, gen: seen.gen + 1 })
    const el = box.current
    const animated = !!el && !prefersReducedMotion() && typeof el.animate === 'function'
    // the last committed content becomes the leaving layer
    // mid-swap: the brightest layer on screen, so that the text never dips
    const layers = animated ? [...el.querySelectorAll<HTMLElement>(':scope > .mIn')] : []
    setGhost(animated ? { ...last.current, h0: el.offsetHeight, o0: Math.max(...layers.map((m) => Number(getComputedStyle(m).opacity))) } : null)
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
    if (fade) el.style.minHeight = `${ghost.h0}px`
    const ease = 'cubic-bezier(.2,.8,.2,1)'
    const anims = fade
      ? [
          old.animate([{ opacity: ghost.o0 }, { opacity: 0 }], { duration: 180, easing: 'linear', fill: 'forwards' }),
          cur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'linear', fill: 'backwards' }),
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
      el.style.minHeight = ''
      setGhost((g) => (g === ghost ? null : g))
    }
    // the last animation is the new content's, the longest one: ending earlier would cut its tail with a visible snap
    anims[anims.length - 1].onfinish = finish
    const t = setTimeout(finish, 480)
    return () => {
      clearTimeout(t)
      if (!done) {
        done = true
        anims.forEach((a) => a.cancel())
        el.style.overflow = ''
        el.style.minHeight = ''
      }
    }
  }, [ghost, fade])

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
