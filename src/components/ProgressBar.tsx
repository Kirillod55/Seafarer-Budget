export type Level = 'ok' | 'warn' | 'over'

/** Horizontal bar for a 0..1 share (clamped to 0..100 %); `level` colours it via CSS variables. */
export function ProgressBar({ share, level }: { share: number; level?: Level }) {
  const percent = Math.min(100, Math.max(0, Math.round(share * 1000) / 10))
  return (
    <div
      className={`bar${level ? ` level-${level}` : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-level={level}
    >
      <div className="bar-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
