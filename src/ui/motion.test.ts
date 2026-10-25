import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTracker, project, rubber, spring } from './motion.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('spring', () => {
  it('with damping 1 reaches `to` without overshooting', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const seen: number[] = []
    const onDone = vi.fn()
    spring({ from: 0, to: 300, velocity: 0, damping: 1, response: 0.35, onUpdate: (v) => seen.push(v), onDone })
    vi.advanceTimersByTime(3000)

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toBe(300)
    expect(Math.max(...seen)).toBeLessThanOrEqual(300)
    // it moves over several frames instead of jumping
    expect(seen.length).toBeGreaterThan(5)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  it('with damping below 1 overshoots a little, then settles on `to`', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const seen: number[] = []
    spring({ from: 0, to: 100, velocity: 0, damping: 0.6, response: 0.35, onUpdate: (v) => seen.push(v) })
    vi.advanceTimersByTime(4000)
    expect(Math.max(...seen)).toBeGreaterThan(100)
    expect(seen.at(-1)).toBe(100)
  })

  it('stop() freezes it on the current frame', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const seen: number[] = []
    const onDone = vi.fn()
    const s = spring({ from: 0, to: 100, velocity: 0, damping: 1, response: 0.35, onUpdate: (v) => seen.push(v), onDone })
    vi.advanceTimersByTime(50)
    s.stop()
    const n = seen.length
    vi.advanceTimersByTime(2000)
    expect(seen.length).toBe(n)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('jumps straight to `to` with Reduce Motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }))
    const seen: number[] = []
    const onDone = vi.fn()
    spring({ from: 0, to: 80, velocity: 500, damping: 1, response: 0.35, onUpdate: (v) => seen.push(v), onDone })
    await Promise.resolve()
    expect(seen).toEqual([80])
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('project', () => {
  it('is where a flick comes to rest (Apple deceleration 0.998)', () => {
    expect(project(1000)).toBeCloseTo((1000 * 0.998) / (1 - 0.998) / 1000, 6)
    expect(project(1000, 0.99)).toBeCloseTo((1000 * 0.99) / (1 - 0.99) / 1000, 6)
    expect(project(0)).toBe(0)
    expect(project(-500)).toBeLessThan(0)
  })
})

describe('rubber', () => {
  it('resists more the further it goes and never reaches the full offset', () => {
    expect(rubber(0, 375)).toBe(0)
    const a = rubber(50, 375)
    const b = rubber(200, 375)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(50)
    expect(b).toBeGreaterThan(a)
    expect(b - a).toBeLessThan(150)
    expect(rubber(-50, 375)).toBeCloseTo(-a, 6)
  })
})

describe('createTracker', () => {
  it('measures finger speed in px/s from the last samples', () => {
    const tr = createTracker()
    expect(tr.velocity()).toBe(0)
    tr.add(0, 1000)
    tr.add(50, 1050)
    tr.add(100, 1100)
    expect(tr.velocity()).toBeCloseTo(1000, 6)
    tr.reset()
    expect(tr.velocity()).toBe(0)
  })

  it('forgets samples older than ~80 ms', () => {
    const tr = createTracker()
    tr.add(0, 0)
    tr.add(10, 500) // a long pause, then a quick move
    tr.add(40, 520)
    tr.add(70, 540)
    expect(tr.velocity()).toBeCloseTo(1500, 6)
  })
})
