// Buy and sell rates for the rates message. Central banks publish one rate, so these come from real banks: PrivatBank's
// public API for the hryvnia and the rates table on maib's site for the leu (maib has no API). Shown only, never used
// to convert money; when a source is down its lines fall back to the official rate. No npm imports.

export interface BuySell {
  buy: number
  sell: number
}
export interface BankPair {
  uah: BuySell | null
  mdl: BuySell | null
}
export type BankRates = Record<'USD' | 'EUR', BankPair>

export const PRIVAT_URL = 'https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=5'
export const MAIB_URL = 'https://www.maib.md/en'

export const noBankRates = (): BankRates => ({ USD: { uah: null, mdl: null }, EUR: { uah: null, mdl: null } })

const valid = (buy: number, sell: number): BuySell | null =>
  Number.isFinite(buy) && Number.isFinite(sell) && buy > 0 && sell >= buy ? { buy, sell } : null

export function parsePrivat(json: unknown, unit: 'USD' | 'EUR'): BuySell | null {
  if (!Array.isArray(json)) return null
  const row = json.find((r) => r && typeof r === 'object' && (r as { ccy?: unknown }).ccy === unit) as
    | { buy?: unknown; sale?: unknown }
    | undefined
  return row ? valid(Number(row.buy), Number(row.sale)) : null
}

/** The first table with the rate rows on maib's page: <td>USD</td>, then the buy and the sell cells. */
export function parseMaib(html: string, unit: 'USD' | 'EUR'): BuySell | null {
  const table = /<table class="table exchange__table">[\s\S]*?<\/table>/.exec(html)?.[0]
  if (!table) return null
  const num = '<td>\\s*(?:<span[^>]*>)?\\s*([\\d.]+)\\s*(?:</span>)?\\s*</td>'
  const m = new RegExp(`<td>\\s*${unit}\\s*</td>\\s*${num}\\s*${num}`).exec(table)
  return m ? valid(Number(m[1]), Number(m[2])) : null
}

type Get = (url: string) => Promise<Response>
const get: Get = (url) => fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SeafarerBudget)' }, signal: AbortSignal.timeout(10_000) })

/** Both sources, each on its own: one being down never stops the other. */
export async function loadBankRates(fetcher: Get = get): Promise<BankRates> {
  const out = noBankRates()
  const [privat, maib] = await Promise.allSettled([
    fetcher(PRIVAT_URL).then((r) => (r.ok ? r.json() : null)),
    fetcher(MAIB_URL).then((r) => (r.ok ? r.text() : '')),
  ])
  for (const unit of ['USD', 'EUR'] as const) {
    if (privat.status === 'fulfilled') out[unit].uah = parsePrivat(privat.value, unit)
    if (maib.status === 'fulfilled') out[unit].mdl = parseMaib(String(maib.value), unit)
  }
  return out
}
