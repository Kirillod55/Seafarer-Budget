import { useSyncExternalStore } from 'react'

/*
 * Which layout the window gets (spec §11 «Ширина окна»): under 1024 px the phone one (tabs, sheet, gestures);
 * 1024–1279 the PC one with the menu as icons; from 1280 the menu with labels. The choice is two classes on <html>
 * — `desk` (≥ 1024) and `desk-s` (1024–1279) — so nearly all of the PC look is CSS (desk.css); components that need
 * other markup read useLayout(). It switches at once when the window is resized (Windows app and browser alike).
 */

export type Layout = 'phone' | 'icons' | 'full'

export const DESK_MIN = 1024
export const FULL_MIN = 1280

export function layoutFor(width: number): Layout {
  return width >= FULL_MIN ? 'full' : width >= DESK_MIN ? 'icons' : 'phone'
}

let current: Layout = 'phone'
const subs = new Set<() => void>()

export function applyLayout(mode: Layout, doc: Document = document): void {
  const html = doc.documentElement
  html.classList.toggle('desk', mode !== 'phone')
  html.classList.toggle('desk-s', mode === 'icons')
  if (mode === current) return
  current = mode
  subs.forEach((f) => f())
}

export function currentLayout(): Layout {
  return current
}

/** Applies the layout for the window now and on every crossing of 1024 / 1280; returns the stop function. */
export function watchLayout(win: Window = window, doc: Document = document): () => void {
  if (typeof win.matchMedia !== 'function') {
    applyLayout('phone', doc)
    return () => {}
  }
  const desk = win.matchMedia(`(min-width: ${DESK_MIN}px)`)
  const full = win.matchMedia(`(min-width: ${FULL_MIN}px)`)
  const sync = () => applyLayout(full.matches ? 'full' : desk.matches ? 'icons' : 'phone', doc)
  sync()
  desk.addEventListener?.('change', sync)
  full.addEventListener?.('change', sync)
  // the PC scrollbar is invisible until the page scrolls (desk.css html.scrolling); it fades out 0.8 s after
  let idle: ReturnType<typeof setTimeout> | undefined
  const onScroll = () => {
    doc.documentElement.classList.add('scrolling')
    clearTimeout(idle)
    idle = setTimeout(() => doc.documentElement.classList.remove('scrolling'), 800)
  }
  win.addEventListener?.('scroll', onScroll, { passive: true })
  return () => {
    desk.removeEventListener?.('change', sync)
    full.removeEventListener?.('change', sync)
    win.removeEventListener?.('scroll', onScroll)
    clearTimeout(idle)
  }
}

function subscribe(f: () => void): () => void {
  subs.add(f)
  return () => subs.delete(f)
}

/** The current layout; re-renders when the window crosses 1024 / 1280. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, currentLayout, currentLayout)
}

/** True on the PC layout (either width). */
export function useDesk(): boolean {
  return useLayout() !== 'phone'
}
