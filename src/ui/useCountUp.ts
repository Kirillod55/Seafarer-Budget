import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './motion.ts'

/*
 * Numbers that count to their new value (spec §6 «Цифры … плавно досчитываются», 0.6 s; prototype tween()):
 * returns the number to show now. The first value shows as is; each change runs from the number on screen
 * (even mid-way) to the new one with an ease-out. Reduce Motion: the new value at once.
 * Format the result with money() — it rounds the in-between values.
 */
export function useCountUp(value: number, ms = 600): number {
  const [shown, setShown] = useState(value)
  const shownRef = useRef(value)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    const from = shownRef.current
    if (reduced || from === value) {
      shownRef.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    let id = 0
    const step = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - t0) / ms))
      const v = p >= 1 ? value : from + (value - from) * (1 - Math.pow(1 - p, 3))
      shownRef.current = v
      setShown(v)
      if (p < 1) id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [value, ms, reduced])

  return reduced ? value : shown
}
