/*
 * Currency names and signs for the currency menu (spec §4 «Окно выбора валюты»), ported from the prototype
 * (SYM, CUR_NAMES, CUR_BASE, curLabel, curOpts). Amounts themselves are written by money() in @shared/format.ts.
 */

/** Sign in the round badge of the menu; a currency without one shows its first letter. */
export const SYM: Record<string, string> = {
  USD: '$',
  UAH: '₴',
  EUR: '€',
  MDL: 'L',
  PLN: 'zł',
  GBP: '£',
  TRY: '₺',
  GEL: '₾',
  RON: 'lei',
  CHF: 'Fr',
}

export const CUR_NAMES: Record<string, string> = {
  USD: 'Доллар США',
  UAH: 'Гривна',
  EUR: 'Евро',
  MDL: 'Молдавский лей',
  PLN: 'Польский злотый',
  GBP: 'Фунт стерлингов',
  TRY: 'Турецкая лира',
  GEL: 'Грузинский лари',
  RON: 'Румынский лей',
  CHF: 'Швейцарский франк',
}

/** The currencies every currency menu offers (the wizard and «Основная валюта»), before the user's own. */
export const CUR_BASE = ['USD', 'UAH', 'EUR', 'MDL', 'PLN', 'GBP', 'TRY']

/** «USD $», «MDL L», «XYZ». */
export const curLabel = (code: string): string => code + (SYM[code] ? ` ${SYM[code]}` : '')

/** The sign in the badge: «$», or the first letter for a currency without a sign. */
export const curSign = (code: string): string => SYM[code] ?? code.slice(0, 1)

/** «Доллар США», or «Своя валюта» for a code we have no name for. */
export const curName = (code: string): string => CUR_NAMES[code] ?? 'Своя валюта'

/** Menu options for a list of codes (duplicates dropped, order kept), e.g. `curOptions([...CUR_BASE, ...mine])`. */
export function curOptions(codes: string[]): { value: string; label: string; sub: string }[] {
  return [...new Set(codes)].map((c) => ({ value: c, label: curLabel(c), sub: curName(c) }))
}
