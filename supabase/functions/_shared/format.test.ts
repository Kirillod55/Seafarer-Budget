import { describe, expect, it } from 'vitest'
import { money } from './format.ts'

describe('money (English format)', () => {
  it('puts the symbol first with comma thousands and a dot for decimals', () => {
    expect(money(4963.32, 'USD')).toBe('$4,963.32')
    expect(money(1200, 'UAH')).toBe('₴1,200')
    expect(money(12.5, 'EUR')).toBe('€12.50')
    expect(money(1.94, 'USD')).toBe('$1.94')
    expect(money(1234567.5, 'USD')).toBe('$1,234,567.50')
  })

  it('knows the symbols of PLN, GBP, TRY and GEL', () => {
    expect(money(5, 'PLN')).toBe('zł5')
    expect(money(5, 'GBP')).toBe('£5')
    expect(money(5, 'TRY')).toBe('₺5')
    expect(money(5, 'GEL')).toBe('₾5')
  })

  it('writes currencies without a symbol as code, space, number', () => {
    expect(money(90, 'MDL')).toBe('MDL 90')
    expect(money(100, 'XYZ')).toBe('XYZ 100')
    expect(money(1234.5, 'XYZ')).toBe('XYZ 1,234.50')
  })

  it('drops decimals for whole numbers', () => {
    expect(money(100, 'USD')).toBe('$100')
    expect(money(80, 'UAH')).toBe('₴80')
  })

  it('rounds to an integer with { whole: true }', () => {
    expect(money(1540.4, 'USD', { whole: true })).toBe('$1,540')
    expect(money(50.67, 'USD', { whole: true })).toBe('$51')
    expect(money(12.5, 'EUR', { whole: true })).toBe('€13')
  })

  it('puts a leading minus before the symbol', () => {
    expect(money(-12.5, 'USD')).toBe('-$12.50')
    expect(money(-80, 'UAH')).toBe('-₴80')
    expect(money(-50.67, 'USD', { whole: true })).toBe('-$51')
    expect(money(-90, 'MDL')).toBe('-MDL 90')
  })

  it('never shows a minus for zero', () => {
    expect(money(0, 'USD')).toBe('$0')
    expect(money(0.004, 'USD')).toBe('$0')
    expect(money(-0.001, 'USD')).toBe('$0')
    expect(money(-0.4, 'USD', { whole: true })).toBe('$0')
  })
})
