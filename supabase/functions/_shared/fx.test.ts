import { describe, expect, it } from 'vitest'
import { nbuUrl, parseNbu, round2, usdRate } from './fx.ts'
import type { FxRate } from './types.ts'

const CURRENCIES = ['UAH', 'USD', 'EUR', 'MDL']

describe('nbuUrl', () => {
  it('builds the NBU exchange url for a date', () => {
    expect(nbuUrl('2026-10-21')).toBe(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=20261021&json',
    )
  })
})

describe('parseNbu', () => {
  it('keeps requested currencies, adds synthetic UAH, ignores others', () => {
    const json = [
      { cc: 'USD', rate: 41.2, exchangedate: '21.10.2026' },
      { cc: 'EUR', rate: 44.9, exchangedate: '21.10.2026' },
      { cc: 'GBP', rate: 52, exchangedate: '21.10.2026' },
    ]
    const out = parseNbu(json, CURRENCIES)
    expect(out).toHaveLength(3)
    expect(out).toContainEqual({ date: '2026-10-21', currency: 'USD', uah_per_unit: 41.2 })
    expect(out).toContainEqual({ date: '2026-10-21', currency: 'EUR', uah_per_unit: 44.9 })
    expect(out).toContainEqual({ date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 })
    expect(out.find((r) => r.currency === 'GBP')).toBeUndefined()
  })

  it('returns [] when json is not an array', () => {
    expect(parseNbu({ foo: 1 }, CURRENCIES)).toEqual([])
    expect(parseNbu(null, CURRENCIES)).toEqual([])
  })
})

describe('usdRate', () => {
  const rates: FxRate[] = [
    { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 },
    { date: '2026-10-21', currency: 'USD', uah_per_unit: 41.2 },
    { date: '2026-10-21', currency: 'EUR', uah_per_unit: 44.9 },
  ]

  it('USD is always 1 and exact', () => {
    expect(usdRate(rates, 'USD', '2026-10-21')).toEqual({ rate: 1, exact: true })
    expect(usdRate([], 'USD', '2026-10-21')).toEqual({ rate: 1, exact: true })
  })

  it('converts UAH via the USD rate on the exact date', () => {
    const r = usdRate(rates, 'UAH', '2026-10-21')!
    expect(r.rate).toBeCloseTo(1 / 41.2, 10)
    expect(r.exact).toBe(true)
  })

  it('falls back to the latest earlier rate and flags it not exact', () => {
    const old: FxRate[] = [
      { date: '2026-10-17', currency: 'USD', uah_per_unit: 41 },
      { date: '2026-10-17', currency: 'EUR', uah_per_unit: 45 },
      { date: '2026-10-10', currency: 'EUR', uah_per_unit: 40 },
    ]
    const r = usdRate(old, 'EUR', '2026-10-19')!
    expect(r.rate).toBeCloseTo(45 / 41, 10)
    expect(r.exact).toBe(false)
  })

  it('returns null when no rate on or before the date', () => {
    const later: FxRate[] = [
      { date: '2026-10-25', currency: 'USD', uah_per_unit: 41 },
      { date: '2026-10-25', currency: 'EUR', uah_per_unit: 45 },
    ]
    expect(usdRate(later, 'EUR', '2026-10-19')).toBeNull()
    expect(usdRate([], 'EUR', '2026-10-19')).toBeNull()
  })
})

describe('round2', () => {
  it('rounds float error away', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
  })
})
