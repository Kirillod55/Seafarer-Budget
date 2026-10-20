// Date helpers. Dates are 'YYYY-MM-DD' strings, months are 'YYYY-MM'.
// All arithmetic is done in UTC so DST never shifts a day.

const MS_PER_DAY = 86_400_000

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// Older engines (ICU before 2022) only know the pre-2022 name of Kyiv.
const LEGACY_ZONE: Record<string, string> = { 'Europe/Kyiv': 'Europe/Kiev' }

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
  try {
    return new Intl.DateTimeFormat('en-US', opts)
  } catch (e) {
    const legacy = LEGACY_ZONE[timeZone]
    if (!(e instanceof RangeError) || !legacy) throw e
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: legacy })
  }
}

/** Calendar date of `now` in the given IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  const parts = dayFormat(timeZone).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY)
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY)
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 7)
}
