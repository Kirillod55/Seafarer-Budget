import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLayout, currentLayout, layoutFor, watchLayout } from './layout.ts'

/** A matchMedia whose min-width queries answer for `width`; `resize(w)` fires their change listeners. */
function fakeWindow(width: number) {
  const listeners = new Set<() => void>()
  let w = width
  const win = {
    matchMedia: (q: string) => {
      const min = Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? 0)
      return {
        get matches() {
          return w >= min
        },
        media: q,
        addEventListener: (_: string, f: () => void) => listeners.add(f),
        removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      }
    },
  }
  return {
    win: win as unknown as Window,
    resize(nw: number) {
      w = nw
      listeners.forEach((f) => f())
    },
    listeners,
  }
}

afterEach(() => {
  document.documentElement.classList.remove('desk', 'desk-s')
})

describe('layout by window width (spec §11 «Ширина окна»)', () => {
  it('1023 → phone, 1024 → icons, 1280 → full', () => {
    expect(layoutFor(375)).toBe('phone')
    expect(layoutFor(1023)).toBe('phone')
    expect(layoutFor(1024)).toBe('icons')
    expect(layoutFor(1279)).toBe('icons')
    expect(layoutFor(1280)).toBe('full')
    expect(layoutFor(1440)).toBe('full')
  })

  it('applyLayout puts desk / desk-s on <html>; phone removes both', () => {
    const html = document.documentElement
    applyLayout('icons')
    expect(html.classList.contains('desk')).toBe(true)
    expect(html.classList.contains('desk-s')).toBe(true)
    applyLayout('full')
    expect(html.classList.contains('desk')).toBe(true)
    expect(html.classList.contains('desk-s')).toBe(false)
    applyLayout('phone')
    expect(html.classList.contains('desk')).toBe(false)
    expect(html.classList.contains('desk-s')).toBe(false)
  })

  it('classes follow the media queries at once on resize', () => {
    const f = fakeWindow(900)
    const stop = watchLayout(f.win)
    const html = document.documentElement
    expect(html.classList.contains('desk')).toBe(false)
    f.resize(1100)
    expect(html.classList.contains('desk')).toBe(true)
    expect(html.classList.contains('desk-s')).toBe(true)
    f.resize(1440)
    expect(html.classList.contains('desk-s')).toBe(false)
    expect(currentLayout()).toBe('full')
    stop()
    expect(f.listeners.size).toBe(0)
  })

  it('without matchMedia (tests, old engines) the phone layout stays', () => {
    const stop = watchLayout({} as Window)
    expect(currentLayout()).toBe('phone')
    stop()
    vi.unstubAllGlobals()
  })
})
