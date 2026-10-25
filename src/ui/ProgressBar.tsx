import { useLayoutEffect, useRef } from 'react'
import { prefersReducedMotion } from './motion.ts'
import './ui.css'

export type Level = 'ok' | 'warn' | 'over'

/*
 * Progress bar (spec §6 «Полоски»; prototype .bar and animate()): it grows from zero when it appears (opening the
 * screen) and glides to a new width when the data change (CSS transition 0.8 s, --ios). Reduce Motion: no growth.
 * `level` colours it: ok lime, warn amber, over orange.
 */
export function ProgressBar({ value, max, level, thin }: { value: number; max: number; level?: Level; thin?: boolean }) {
  const share = max > 0 ? value / max : 0
  const percent = Math.min(100, Math.max(0, Math.round(share * 1000) / 10))
  const fill = useRef<HTMLDivElement>(null)

  // first paint at 0 %, then let the transition carry it to the real width
  useLayoutEffect(() => {
    const el = fill.current
    if (!el || prefersReducedMotion()) return
    const to = el.style.width
    el.style.transition = 'none'
    el.style.width = '0%'
    void el.offsetWidth
    el.style.transition = ''
    el.style.width = to
  }, [])

  return (
    <div
      className={`bar${thin ? ' thin' : ''}${level ? ` level-${level}` : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-level={level}
    >
      <div ref={fill} className="bar-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
