import type { BankRates } from '@shared/bankRates.ts'

export const BANK_RATES_KEY = 'bankRates'
export const BANK_REFRESH_MS = 30 * 60 * 1000
const BANK_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The banks' rates kept by the sync (meta); older than a day they do not count and the official rates are shown. */
export function freshBankRates(stored: unknown, nowMs: number): BankRates | undefined {
  const s = stored as { at: string; rates: BankRates } | undefined
  return s && nowMs - Date.parse(s.at) < BANK_MAX_AGE_MS ? s.rates : undefined
}
