import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'
import { prefersReducedMotion } from './motion.ts'

/*
 * Smooth re-render (spec §6 «Плавная перерисовка»; prototype flipSnap/flipPlay/softRender): when a button adds or
 * removes blocks on the same screen, the other blocks slide to their new place (0.36 s), blocks that change height
 * grow or shrink, a removed block melts where it stood (0.2 s) and a new one fades in.
 *
 * Blocks are the outermost elements with `data-flip-key` inside the container (a key nested in another keyed
 * block belongs to that block); the key is a stable name — the block's heading, or the section title above it.
 * Anything without a key (the nav bar) takes no part. Reduce Motion: nothing moves.
 *
 * Usage: `useFlip(screenRef, [goals.length, panel])` — when the deps change, positions are read before React
 * commits the new DOM (during render) and played back right after it (layout effect, before paint).
 *
 * Contract: the deps must change in the component that calls useFlip (its own state, props or live query) —
 * the snapshot is taken while THAT component renders. A child that re-renders on its own takes no snapshot,
 * so a change that only lives inside a child does not animate. Deps are compared with the last COMMITTED ones:
 * a render React throws away (concurrent rendering) leaves nothing behind — the next render that differs from
 * what is on screen reads the positions again.
 */

/** iOS curve (--ios), as the spec asks for the slide */
const EASE = 'cubic-bezier(.32,.72,0,1)'

interface Snap {
  /** key#n → element and its box relative to the container */
  map: Map<string, { el: HTMLElement; top: number; left: number; width: number; height: number }>
}

function blocks(box: HTMLElement): [key: string, el: HTMLElement][] {
  const seen: Record<string, number> = {}
  const out: [string, HTMLElement][] = []
  for (const el of box.querySelectorAll<HTMLElement>('[data-flip-key]')) {
    // only the outermost keyed blocks; ghosts never count
    const outer = el.parentElement?.closest('[data-flip-key]')
    if (outer && outer !== box && box.contains(outer)) continue
    const k = el.dataset.flipKey!
    seen[k] = (seen[k] ?? 0) + 1
    out.push([`${k}#${seen[k]}`, el])
  }
  return out
}

function snap(box: HTMLElement | null): Snap | null {
  if (!box || prefersReducedMotion() || typeof box.animate !== 'function') return null
  const b = box.getBoundingClientRect()
  const map: Snap['map'] = new Map()
  for (const [k, el] of blocks(box)) {
    const r = el.getBoundingClientRect()
    map.set(k, { el, top: r.top - b.top, left: r.left - b.left, width: r.width, height: r.height })
  }
  return { map }
}

function play(box: HTMLElement | null, s: Snap) {
  if (!box) return
  const now = blocks(box)
  const used = new Set<string>()
  // 1. blocks that change height start from their old height. This must come first: at t=0 the blocks below
  //    are then pushed back near their old places, and their slide is measured from there (step 2) — measured
  //    against the final layout instead, they would start off by the height change and jump over the block above.
  for (const [k, el] of now) {
    const o = s.map.get(k)
    if (!o) continue
    const h = el.getBoundingClientRect().height
    if (Math.abs(o.height - h) <= 1) continue
    el.style.overflow = 'clip'
    const a = el.animate([{ height: `${o.height}px` }, { height: `${h}px` }], { duration: 360, easing: EASE })
    const done = () => void (el.style.overflow = '')
    a.onfinish = done
    a.oncancel = done
    setTimeout(done, 420)
  }
  // 2. read where everything stands at t=0, then slide each kept block from its old place; new blocks fade in
  const b = box.getBoundingClientRect()
  const tops = now.map(([, el]) => el.getBoundingClientRect().top - b.top)
  now.forEach(([k, el], i) => {
    const o = s.map.get(k)
    if (!o) {
      el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 300,
        delay: 40,
        easing: EASE,
        fill: 'backwards',
      })
      return
    }
    used.add(k)
    const dy = o.top - tops[i]
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 360, easing: EASE })
  })
  // removed blocks: a copy melts away where the block stood (React has already taken the real one out)
  for (const [k, o] of s.map) {
    if (used.has(k)) continue
    const g = o.el.cloneNode(true) as HTMLElement
    g.removeAttribute('id')
    g.removeAttribute('data-flip-key')
    g.querySelectorAll('[id],[data-flip-key]').forEach((x) => {
      x.removeAttribute('id')
      x.removeAttribute('data-flip-key')
    })
    g.classList.add('flipghost')
    g.setAttribute('aria-hidden', 'true')
    g.setAttribute('inert', '')
    Object.assign(g.style, {
      position: 'absolute',
      left: `${o.left}px`,
      top: `${o.top}px`,
      width: `${o.width}px`,
      height: `${o.height}px`,
      margin: '0',
      pointerEvents: 'none',
      zIndex: '1',
    })
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
    box.append(g)
    const a = g.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.98)' }], {
      duration: 200,
      easing: 'ease-in',
      fill: 'forwards',
    })
    const rm = () => g.remove()
    a.onfinish = rm
    setTimeout(rm, 320)
  }
}

const same = (a: DependencyList, b: DependencyList) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

export function useFlip(containerRef: RefObject<HTMLElement | null>, deps: DependencyList): void {
  const committed = useRef<DependencyList | null>(null)
  const pending = useRef<Snap | null>(null)

  // Read the old positions while the DOM still shows them: during a render whose deps differ from the screen's.
  if (committed.current && !same(committed.current, deps)) pending.current = snap(containerRef.current)

  useLayoutEffect(() => {
    committed.current = deps
    const s = pending.current
    pending.current = null
    if (s) play(containerRef.current, s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
