import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, daysBetween, localDate, monthOf, prevMonth } from './dates.ts'

describe('localDate', () => {
  it('uses the time zone, not UTC', () => {
    expect(localDate(new Date('2026-10-20T21:30:00Z'), 'Europe/Kyiv')).toBe('2026-10-21')
    expect(localDate(new Date('2026-10-20T21:30:00Z'), 'UTC')).toBe('2026-10-20')
  })

  describe('M4: an engine without Europe/Kyiv', () => {
    afterEach(() => vi.restoreAllMocks())

    it('falls back to Europe/Kiev', () => {
      const Original = Intl.DateTimeFormat
      const seen: string[] = []
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((function (locale: string, opts: Intl.DateTimeFormatOptions) {
        seen.push(String(opts?.timeZone))
        if (opts?.timeZone === 'Europe/Kyiv') throw new RangeError('Invalid time zone specified: Europe/Kyiv')
        return new Original(locale, opts)
      }) as never)
      expect(localDate(new Date('2026-10-20T21:30:00Z'), 'Europe/Kyiv')).toBe('2026-10-21')
      expect(seen).toEqual(['Europe/Kyiv', 'Europe/Kiev'])
    })

    it('other invalid zones still throw', () => {
      expect(() => localDate(new Date(), 'Mars/Olympus')).toThrow(RangeError)
    })
  })
})

describe('addDays', () => {
  it('adds and subtracts days across month and year borders', () => {
    expect(addDays('2026-10-21', -1)).toBe('2026-10-20')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('is not affected by DST changes', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
  })
})

describe('daysBetween', () => {
  it('counts days from -> to', () => {
    expect(daysBetween('2026-10-21', '2026-11-20')).toBe(30)
    expect(daysBetween('2026-11-20', '2026-10-21')).toBe(-30)
    expect(daysBetween('2026-10-21', '2026-10-21')).toBe(0)
  })
  it('is exact across DST changes', () => {
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31)
  })
})

describe('monthOf / prevMonth', () => {
  it('extracts the month', () => {
    expect(monthOf('2026-10-21')).toBe('2026-10')
  })
  it('steps back one month', () => {
    expect(prevMonth('2026-01')).toBe('2025-12')
    expect(prevMonth('2026-10')).toBe('2026-09')
  })
})
