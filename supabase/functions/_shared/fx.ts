import type { FxRate } from './types.ts'

export function nbuUrl(date: string): string {
  return `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${date.replaceAll('-', '')}&json`
}

// NBU returns UAH per 1 unit of foreign currency; exchangedate is DD.MM.YYYY.
export function parseNbu(json: unknown, currencies: string[]): FxRate[] {
  if (!Array.isArray(json)) return []
  const out: FxRate[] = []
  let uahDate: string | null = null
  for (const item of json) {
    if (!item || typeof item !== 'object') continue
    const { cc, rate, exchangedate } = item as Record<string, unknown>
    if (typeof cc !== 'string' || typeof rate !== 'number' || typeof exchangedate !== 'string') continue
    if (!currencies.includes(cc) || cc === 'UAH') continue
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(exchangedate)
    if (!m) continue
    const date = `${m[3]}-${m[2]}-${m[1]}`
    uahDate ??= date
    out.push({ date, currency: cc, uah_per_unit: rate })
  }
  if (uahDate) out.push({ date: uahDate, currency: 'UAH', uah_per_unit: 1 })
  return out
}

function latestOnOrBefore(rates: FxRate[], currency: string, date: string): FxRate | null {
  let best: FxRate | null = null
  for (const r of rates) {
    if (r.currency !== currency || r.date > date) continue
    if (!best || r.date > best.date) best = r
  }
  return best
}

// USD value of one unit of `currency` on `date`; exact only if both rates are dated `date`.
export function usdRate(
  rates: FxRate[],
  currency: string,
  date: string,
): { rate: number; exact: boolean } | null {
  if (currency === 'USD') return { rate: 1, exact: true }
  const cur = latestOnOrBefore(rates, currency, date)
  const usd = latestOnOrBefore(rates, 'USD', date)
  if (!cur || !usd) return null
  return { rate: cur.uah_per_unit / usd.uah_per_unit, exact: cur.date === date && usd.date === date }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
