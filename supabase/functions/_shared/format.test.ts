import { describe, expect, it } from 'vitest'
import { money } from './format.ts'

describe('money', () => {
  it('formats USD with a $ prefix and dot decimals', () => {
    expect(money(1.94, 'USD')).toBe('$1.94')
    expect(money(80.94, 'USD')).toBe('$80.94')
    expect(money(12.5, 'USD')).toBe('$12.50')
  })

  it('formats UAH / EUR / MDL as number, space, symbol with comma decimals', () => {
    expect(money(80, 'UAH')).toBe('80 ₴')
    expect(money(12.5, 'EUR')).toBe('12,50 €')
    expect(money(90, 'MDL')).toBe('90 L')
  })

  it('drops decimals for whole numbers', () => {
    expect(money(100, 'USD')).toBe('$100')
    expect(money(80, 'UAH')).toBe('80 ₴')
  })

  it('separates thousands with a regular space', () => {
    expect(money(1540, 'USD')).toBe('$1 540')
    expect(money(1200, 'UAH')).toBe('1 200 ₴')
    expect(money(1234567.5, 'USD')).toBe('$1 234 567.50')
  })

  it('rounds to an integer with { whole: true }', () => {
    expect(money(1540.27, 'USD', { whole: true })).toBe('$1 540')
    expect(money(50.67, 'USD', { whole: true })).toBe('$51')
    expect(money(12.5, 'EUR', { whole: true })).toBe('13 €')
  })

  it('puts a leading minus on negatives', () => {
    expect(money(-12.5, 'USD')).toBe('-$12.50')
    expect(money(-80, 'UAH')).toBe('-80 ₴')
    expect(money(-50.67, 'USD', { whole: true })).toBe('-$51')
  })

  it('never shows a minus for zero', () => {
    expect(money(0, 'USD')).toBe('$0')
    expect(money(-0.001, 'USD')).toBe('$0')
    expect(money(-0.4, 'USD', { whole: true })).toBe('$0')
  })

  it('falls back to the currency code for unknown currencies', () => {
    expect(money(5, 'PLN')).toBe('5 PLN')
  })
})
