// Money formatting shared by the React app and the Telegram bot (Deno).
// Pure TypeScript, no imports from npm.
import { CURRENCY_SYMBOL } from './defaults.ts'

/**
 * USD:            `$1 540`, `$1.94`, `-$12.50`   (symbol first, dot decimals)
 * UAH/EUR/MDL:    `80 ₴`, `12,50 €`, `90 L`     (number, space, symbol, comma decimals)
 * Whole numbers have no decimals; thousands are separated by a regular space.
 * `{ whole: true }` rounds to an integer.
 */
export function money(amount: number, currency: string, opts: { whole?: boolean } = {}): string {
  const cents = opts.whole ? Math.round(Math.abs(amount)) * 100 : Math.round(Math.abs(amount) * 100)
  const negative = amount < 0 && cents !== 0
  const units = Math.floor(cents / 100)
  const frac = cents % 100

  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const isUsd = currency === 'USD'
  const decimals = frac === 0 ? '' : (isUsd ? '.' : ',') + String(frac).padStart(2, '0')
  const body = grouped + decimals
  const sign = negative ? '-' : ''

  if (isUsd) return `${sign}$${body}`
  return `${sign}${body} ${CURRENCY_SYMBOL[currency] ?? currency}`
}
