// Money formatting shared by the React app and the Telegram bot (Deno).
// Pure TypeScript, no imports from npm.
import { CURRENCY_SYMBOL } from './defaults.ts'

/**
 * English format, no settings:
 * currencies with a sign: `$4,963.32`, `₴1,200`, `€12.50`, `zł5`, `-$12.50`  (sign first, glued)
 * currencies without one: `MDL 90`, `XYZ 100`                                 (code, space, number)
 * Thousands are separated by commas, decimals by a dot (exactly 2 digits, only when not whole).
 * `{ whole: true }` rounds to an integer. Zero is never negative.
 */
export function money(amount: number, currency: string, opts: { whole?: boolean } = {}): string {
  const cents = opts.whole ? Math.round(Math.abs(amount)) * 100 : Math.round(Math.abs(amount) * 100)
  const negative = amount < 0 && cents !== 0
  const units = Math.floor(cents / 100)
  const frac = cents % 100

  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = grouped + (frac === 0 ? '' : '.' + String(frac).padStart(2, '0'))
  const sign = negative ? '-' : ''

  const symbol = CURRENCY_SYMBOL[currency]
  return symbol ? `${sign}${symbol}${body}` : `${sign}${currency} ${body}`
}
