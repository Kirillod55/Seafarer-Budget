import type { CSSProperties } from 'react'
import { money } from '@shared/format.ts'

export interface DonutPart {
  key: string
  label: string
  /** USD */
  value: number
  color: string
}

const R = 84
const C = 2 * Math.PI * R

/*
 * The report's ring (spec §6 «Отчёт — переделан»; prototype donut()): sectors in the category colours with small
 * gaps, no grey track, drawn one after another (CSS, off with Reduce Motion). The centre shows the active
 * category's share in its colour, its name and sum — by default the largest (parts come sorted, largest first).
 * Pointing at a sector makes it the active one (thicker, the others dimmed); a tap on it calls onPick. The rows
 * next to the ring carry the same numbers as text and are the keyboard / VoiceOver way in, so the sectors are
 * hidden from assistive technology.
 */
export function Donut({
  parts,
  total,
  active,
  onActive,
  onPick,
}: {
  parts: DonutPart[]
  total: number
  /** the highlighted part (hover / focus on a sector or a row); null = none, the centre shows the largest */
  active: number | null
  onActive(i: number | null): void
  onPick(i: number): void
}) {
  const gap = parts.length > 1 ? 2.4 : 0
  const shown = parts[active ?? 0]
  let off = 0
  return (
    <div className={`dwrap${active !== null ? ' hl' : ''}`} onMouseLeave={() => onActive(null)}>
      <svg className="donutsvg" viewBox="0 0 200 200" aria-hidden="true">
        {parts.map((p, i) => {
          const len = total > 0 ? (p.value / total) * C : 0
          const start = off
          off += len
          return (
            <circle
              key={p.key}
              className={`arc${i === active ? ' on' : ''}`}
              data-arc={i}
              cx="100"
              cy="100"
              r={R}
              fill="none"
              stroke={p.color}
              strokeWidth="22"
              strokeDasharray={`${Math.max(len - gap, 0.01)} ${C}`}
              strokeDashoffset={-start}
              transform="rotate(-90 100 100)"
              style={{ '--i': i } as CSSProperties}
              onMouseEnter={() => onActive(i)}
              onClick={() => onPick(i)}
            />
          )
        })}
      </svg>
      {shown && (
        <div className="dcenter" aria-live="polite">
          <b className="dc-pct num" style={{ color: shown.color }}>{`${Math.round((shown.value / total) * 100)}%`}</b>
          <span className="dc-name">{shown.label}</span>
          <span className="label num">{money(shown.value, 'USD', { whole: true })}</span>
        </div>
      )}
    </div>
  )
}
