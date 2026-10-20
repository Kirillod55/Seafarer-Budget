import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { csvFileName, toCsv } from './export.ts'

const HEADER = 'Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка'

const cafe = { id: 'c1', name: 'Кафе и рестораны', kind: 'expense', icon: '☕', keywords: [], archived: false, sort: 1, deleted: false } as Category
const main = { id: 'a1', name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0, deleted: false } as Account
const cash = { id: 'a2', name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1, deleted: false } as Account

function tx(patch: Partial<Transaction>): Transaction {
  return {
    id: 't',
    kind: 'expense',
    amount: 10,
    currency: 'UAH',
    rate_usd: 0.025,
    amount_usd: 0.25,
    rate_pending: false,
    account_id: 'a1',
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: null,
    date: '2026-10-21',
    note: '',
    source: 'app',
    created_at: '2026-10-21T12:00:00Z',
    deleted: false,
    ...patch,
  }
}

const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '')

describe('toCsv', () => {
  it('starts with a BOM and the header row', () => {
    const csv = toCsv([], [cafe], [main])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(lines(csv)).toEqual([HEADER])
  })

  it('writes a decimal comma: 12.5 becomes 12,5 (amount and USD amount)', () => {
    const csv = toCsv([tx({ amount: 12.5, amount_usd: 0.31, category_id: 'c1', note: 'кофе' })], [cafe], [main])
    expect(lines(csv)[1]).toBe('2026-10-21;Расход;12,5;UAH;0,31;Кафе и рестораны;Основной;кофе')
  })

  it('leaves deleted transactions out', () => {
    const csv = toCsv([tx({ id: 'x', deleted: true, note: 'удалено' }), tx({ id: 'y', note: 'живое' })], [], [main])
    expect(lines(csv)).toHaveLength(2)
    expect(csv).not.toContain('удалено')
    expect(csv).toContain('живое')
  })

  it.each([
    ['expense', 'Расход'],
    ['income', 'Доход'],
    ['transfer', 'Перевод'],
    ['exchange', 'Обмен'],
    ['adjustment', 'Корректировка'],
  ] as const)('labels kind %s as %s', (kind, label) => {
    expect(lines(toCsv([tx({ kind })], [], [main]))[1].split(';')[1]).toBe(label)
  })

  describe('second leg of a transfer / exchange (complete copy)', () => {
    const transfer = { kind: 'transfer', to_account_id: 'a2' } as const
    const exchange = { kind: 'exchange', amount: 1000, to_account_id: 'a1', to_amount: 24.5, to_currency: 'USD' } as const
    const row = (patch: Partial<Transaction>) => lines(toCsv([tx(patch)], [], [main, cash]))[1]

    it('transfer: «Счёт» is the source only, «Заметка» is «→ target»', () => {
      expect(row(transfer)).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;→ Наличные')
    })

    it('transfer with a note: «→ target note»', () => {
      expect(row({ ...transfer, note: 'на мелочи' })).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;→ Наличные на мелочи')
    })

    it('transfer with «;» in the note is quoted', () => {
      expect(row({ ...transfer, note: 'а;б' })).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;"→ Наличные а;б"')
    })

    it('exchange: «Заметка» is «→ amount currency» with a decimal comma', () => {
      expect(row(exchange)).toBe('2026-10-21;Обмен;1000;UAH;0,25;;Основной;→ 24,5 USD')
    })

    it('exchange with a note: «→ amount currency note»', () => {
      expect(row({ ...exchange, note: 'в банке' })).toBe('2026-10-21;Обмен;1000;UAH;0,25;;Основной;→ 24,5 USD в банке')
    })

    it('exchange with «;» in the note is quoted', () => {
      expect(row({ ...exchange, note: 'курс 40;5' })).toBe(
        '2026-10-21;Обмен;1000;UAH;0,25;;Основной;"→ 24,5 USD курс 40;5"',
      )
    })
  })

  it('quotes values containing «;», quotes or newlines CSV-style', () => {
    const csv = toCsv([tx({ note: 'a;b "c"\nd' })], [], [main])
    expect(csv).toContain('"a;b ""c""\nd"')
  })

  it('an unknown category or account gives an empty cell; no category is empty too', () => {
    const csv = toCsv([tx({ category_id: 'gone', account_id: 'gone' })], [cafe], [main])
    expect(lines(csv)[1]).toBe('2026-10-21;Расход;10;UAH;0,25;;;')
  })

  it('keeps archived categories and accounts resolvable', () => {
    const csv = toCsv([tx({ category_id: 'c1' })], [{ ...cafe, archived: true }], [{ ...main, archived: true }])
    expect(lines(csv)[1]).toContain(';Кафе и рестораны;Основной;')
  })
})

describe('csvFileName', () => {
  it('is seafarer-budget-YYYY-MM-DD.csv', () => {
    expect(csvFileName('2026-10-21')).toBe('seafarer-budget-2026-10-21.csv')
  })
})
