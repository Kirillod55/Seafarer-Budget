/*
 * Gesture physics, ported from the prototype (spring, project, rubber, tracker) — spec §6 «Второй проход»:
 * springs in Apple's terms (damping ratio + response in seconds) that start from the live on-screen value with
 * the finger's speed and can be stopped on any frame, so every gesture can be caught again mid-flight.
 */

/** iPhone «Уменьшение движения»: springs land on their target at once. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)')?.matches
}

export interface SpringOptions {
  from: number
  to: number
  /** Units per second (px/s for gestures), signed like `to - from`. */
  velocity: number
  /** Damping ratio: 1 = no bounce, < 1 = a bounce. */
  damping: number
  /** Response in seconds: the period of the undamped spring. */
  response: number
  onUpdate(v: number): void
  onDone?(): void
}

export function spring({ from, to, velocity, damping, response, onUpdate, onDone }: SpringOptions): { stop(): void } {
  if (prefersReducedMotion()) {
    let stopped = false
    queueMicrotask(() => {
      if (stopped) return
      onUpdate(to)
      onDone?.()
    })
    return { stop: () => void (stopped = true) }
  }
  const k = Math.pow((2 * Math.PI) / response, 2)
  const c = (4 * Math.PI * damping) / response
  let x = from
  let v = velocity
  let last = performance.now()
  let id = 0
  let stopped = false
  const step = (now: number) => {
    if (stopped) return
    const dt = Math.min(0.064, Math.max(0, (now - last) / 1000))
    last = now
    // small fixed sub-steps keep the integration stable on slow frames
    const n = Math.max(1, Math.ceil(dt / 0.004))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      const a = -k * (x - to) - c * v
      v += a * h
      x += v * h
    }
    if (Math.abs(x - to) < 0.4 && Math.abs(v) < 10) {
      stopped = true
      onUpdate(to)
      onDone?.()
      return
    }
    onUpdate(x)
    id = requestAnimationFrame(step)
  }
  id = requestAnimationFrame(step)
  return {
    stop() {
      stopped = true
      cancelAnimationFrame(id)
    },
  }
}

/** Where a flick comes to rest (Apple's projection): px from px/s; `decel` 0.998 for pages, 0.99 for rows. */
export function project(velocity: number, decel = 0.998): number {
  return ((velocity / 1000) * decel) / (1 - decel)
}

/** Soft resistance past a boundary: the further, the harder; never reaches `offset`. */
export function rubber(offset: number, dim: number, c = 0.55): number {
  return (offset * dim * c) / (dim + c * Math.abs(offset))
}

/** Finger speed (px/s) from the last ~80 ms of samples. */
export function createTracker(): { add(x: number, t?: number): void; velocity(): number; reset(): void } {
  let pts: [x: number, t: number][] = []
  return {
    add(x, t = performance.now()) {
      pts.push([x, t])
      while (pts.length > 2 && t - pts[0][1] > 80) pts.shift()
    },
    velocity() {
      if (pts.length < 2) return 0
      const [x0, t0] = pts[0]
      const [x1, t1] = pts[pts.length - 1]
      return t1 > t0 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0
    },
    reset() {
      pts = []
    },
  }
}
