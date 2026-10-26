import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from './defaults.ts'
import { parseRecords } from './multi.ts'
import type { ParseContext } from './parser.ts'
import type { Account, Category } from './types.ts'

const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c, id: c.name, deleted: false }))
const acc = (name: string, sort: number): Account => ({ id: name, name, aliases: [], is_default: sort === 0, archived: false, sort, deleted: false })
const ctx: ParseContext = {
  currencies: ['UAH', 'USD', 'EUR', 'MDL'], defaultCurrency: 'UAH', categories,
  accounts: [acc('Основной', 0), acc('ProCreditBank', 1)], accountsMode: 'multi', today: '2026-10-21',
}
const records = (text: string, choices?: number[]) => {
  const r = parseRecords(text, ctx, choices)
  if (r.type !== 'records') throw new Error(`expected records for «${text}», got ${JSON.stringify(r)}`)
  return r.items
}
const brief = (text: string) => records(text).map((i) => [i.amount, i.currency, i.categoryId])

describe('parseRecords', () => {
  it('one amount stays a single message', () => {
    expect(parseRecords('кофе 80', ctx).type).toBe('single')
    expect(parseRecords('кофе 1 200', ctx)).toMatchObject({ type: 'single', parsed: { amount: 1200 } })
    expect(parseRecords('2 кофе по 50', ctx)).toMatchObject({ type: 'single', parsed: { amount: 100 } })
    expect(parseRecords('цель машина 500', ctx)).toMatchObject({ type: 'single', parsed: { type: 'goal' } })
  })

  it('lines, «;» and «, »', () => {
    expect(brief('кофе 80\nтакси 150\nатб 420')).toEqual([[80, 'UAH', 'Кафе и рестораны'], [150, 'UAH', 'Транспорт и такси'], [420, 'UAH', 'Продукты']])
    expect(brief('кофе 80; такси 150, атб 12,50')).toEqual([[80, 'UAH', 'Кафе и рестораны'], [150, 'UAH', 'Транспорт и такси'], [12.5, 'UAH', 'Продукты']])
  })

  it('pairs without separators', () => {
    expect(brief('кофе - 50 сигареты 30 молоко сорок стики 300')).toEqual([
      [50, 'UAH', 'Кафе и рестораны'], [30, 'UAH', 'Продукты'], [40, 'UAH', 'Продукты'], [300, 'UAH', 'Продукты'],
    ])
    expect(brief('такси 15 eur обед 200')).toEqual([[15, 'EUR', 'Транспорт и такси'], [200, 'UAH', 'Кафе и рестораны']])
    expect(brief('50 кофе 30 сигареты')).toEqual([[50, 'UAH', 'Кафе и рестораны'], [30, 'UAH', 'Продукты']])
    expect(brief('кофе 2x50 такси 100')).toEqual([[100, 'UAH', 'Кафе и рестораны'], [100, 'UAH', 'Транспорт и такси']])
    expect(records('+3000 usd зп кофе 50').map((i) => i.kind)).toEqual(['income', 'expense'])
  })

  it('a trailing account / date applies to every part', () => {
    const items = records('кофе 50 сигареты 30 прокредит')
    expect(items.map((i) => i.accountId)).toEqual(['ProCreditBank', 'ProCreditBank'])
    expect(items.map((i) => i.note)).toEqual(['кофе', 'сигареты'])
    expect(records('кофе 50 такси 100 вчера').map((i) => i.date)).toEqual(['2026-10-20', '2026-10-20'])
  })

  it('a leading date word or a date line is for all parts without their own date', () => {
    expect(records('вчера кофе 50 такси 100').map((i) => i.date)).toEqual(['2026-10-20', '2026-10-20'])
    expect(records('21.10\nкофе 50\nпозавчера такси 100').map((i) => i.date)).toEqual(['2026-10-21', '2026-10-19'])
    expect(records('20.10\nкофе 50\nтакси 100').map((i) => i.date)).toEqual(['2026-10-20', '2026-10-20'])
  })

  it('an orphan word asks first, then goes where chosen', () => {
    const r = parseRecords('кофе 50 сигареты 30 чек', ctx)
    expect(r).toMatchObject({ type: 'ask', orphans: ['чек'] })
    expect(records('кофе 50 сигареты 30 чек', [1]).map((i) => i.note)).toEqual(['кофе чек', 'сигареты'])
    expect(records('кофе 50 сигареты 30 чек', [0]).map((i) => i.note)).toEqual(['кофе', 'сигареты'])
  })

  it('a line without an amount stops everything', () => {
    expect(parseRecords('кофе 80\nтакси', ctx)).toEqual({ type: 'no_amount', line: 2, text: 'такси' })
  })

  it('future and too many parts', () => {
    expect(parseRecords('кофе 80\n25.10 такси 100', ctx)).toEqual({ type: 'future' })
    expect(parseRecords(Array.from({ length: 21 }, (_, i) => `кофе ${i + 1}`).join('\n'), ctx)).toEqual({ type: 'too_many' })
  })
})
