import { useEffect, useState } from 'react'

/** Milliseconds from now to the next local midnight in the time zone (+0.5 s, so the new day has begun). */
export function msToMidnight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const passed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds()
  return Math.max(1000, 86_400_000 - passed + 500)
}

/**
 * «Сегодня» follows the clock: the screen re-renders at the next local midnight and whenever the app comes back to
 * the screen (an iPhone app sleeps in the background past midnight; its timers do not run there).
 */
export function useDayTick(now: () => Date, timeZone: string | undefined): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!timeZone) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setTick((n) => n + 1)
        arm()
      }, msToMidnight(now(), timeZone))
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setTick((n) => n + 1)
      arm()
    }
    arm()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [now, timeZone])
}
