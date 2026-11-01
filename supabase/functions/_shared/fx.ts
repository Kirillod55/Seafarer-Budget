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

/**
 * The National Bank of Moldova's lei per unit live in fx_rates next to the NBU rows, as currency «BNM:USD» / «BNM:EUR»
 * (uah_per_unit then holds lei). They are for showing the rate only: money is converted by the NBU rates as before,
 * and nothing asks usdRate() for these codes.
 */
export const BNM_PREFIX = 'BNM:'

export function bnmUrl(date: string): string {
  const [y, m, d] = date.split('-')
  return `https://www.bnm.md/en/official_exchange_rates?get_xml=1&date=${d}.${m}.${y}`
}

export function parseBnm(xml: string, date: string): FxRate[] {
  const out: FxRate[] = []
  for (const unit of ['USD', 'EUR']) {
    const m = new RegExp(`<CharCode>${unit}</CharCode>\\s*<Nominal>(\\d+)</Nominal>[\\s\\S]*?<Value>([\\d.]+)</Value>`).exec(xml)
    if (!m) continue
    const rate = Number(m[2]) / Number(m[1])
    if (rate > 0) out.push({ date, currency: BNM_PREFIX + unit, uah_per_unit: rate })
  }
  return out
}

export interface RatePair {
  unit: 'USD' | 'EUR'
  uah: number | null
  mdl: number | null
  /** whose leu rate it is: the Moldovan bank's, or the NBU cross when that one is missing */
  mdlBank: 'BNM' | 'NBU' | null
}

/** The dollar and the euro in hryvnias (NBU) and lei (BNM), the latest rates on or before `date`. */
export function currentRates(rates: FxRate[], date: string): { date: string | null; pairs: RatePair[] } {
  const nbuMdl = latestOnOrBefore(rates, 'MDL', date)
  const pairs = (['USD', 'EUR'] as const).map((unit): RatePair => {
    const r = latestOnOrBefore(rates, unit, date)
    const bnm = latestOnOrBefore(rates, BNM_PREFIX + unit, date)
    const cross = r && nbuMdl ? r.uah_per_unit / nbuMdl.uah_per_unit : null
    return { unit, uah: r ? r.uah_per_unit : null, mdl: bnm ? bnm.uah_per_unit : cross, mdlBank: bnm ? 'BNM' : cross !== null ? 'NBU' : null }
  })
  return { date: latestOnOrBefore(rates, 'USD', date)?.date ?? null, pairs }
}
