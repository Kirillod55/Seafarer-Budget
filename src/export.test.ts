import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { csvFileName, downloadCsv, toCsv } from './export.ts'

const HEADER = 'Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка;Кто;Счёт куда;Сумма куда;Валюта куда'

const cafe = { id: 'c1', name: 'Кафе и рестораны', kind: 'expense', icon: '☕', keywords: [], archived: false, sort: 1, deleted: false, color: null, glyph: null, deleted_at: null, deleted_batch: null } as Category
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
    author: 'owner',
    archived: false,
    deleted_at: null,
    deleted_batch: null,
    deleted: false,
    ...patch,
  }
}

const lines = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '')

describe('toCsv', () => {
  it('starts with a BOM and the header row', () => {
    const csv = toCsv([], [cafe], [main], null)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(lines(csv)).toEqual([HEADER])
  })

  it('writes a decimal comma: 12.5 becomes 12,5 (amount and USD amount)', () => {
    const csv = toCsv([tx({ amount: 12.5, amount_usd: 0.31, category_id: 'c1', note: 'кофе' })], [cafe], [main], null)
    expect(lines(csv)[1]).toBe('2026-10-21;Расход;12,5;UAH;0,31;Кафе и рестораны;Основной;кофе;Я;;;')
  })

  it('leaves deleted transactions out', () => {
    const csv = toCsv([tx({ id: 'x', deleted: true, note: 'удалено' }), tx({ id: 'y', note: 'живое' })], [], [main], null)
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
    expect(lines(toCsv([tx({ kind })], [], [main], null))[1].split(';')[1]).toBe(label)
  })

  // the CSV is the full backup (spec §10): the second leg has columns of its own, the note stays the note
  describe('second leg of a transfer / exchange: «Счёт куда; Сумма куда; Валюта куда»', () => {
    const transfer = { kind: 'transfer', to_account_id: 'a2' } as const
    const exchange = { kind: 'exchange', amount: 1000, to_account_id: 'a1', to_amount: 24.5, to_currency: 'USD' } as const
    const row = (patch: Partial<Transaction>) => lines(toCsv([tx(patch)], [], [main, cash], null))[1]

    it('transfer: the target account, the same amount and currency', () => {
      expect(row(transfer)).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;;Я;Наличные;10;UAH')
    })

    it('transfer with a note: the note is not touched', () => {
      expect(row({ ...transfer, note: 'на мелочи' })).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;на мелочи;Я;Наличные;10;UAH')
    })

    it('transfer with «;» in the note is quoted', () => {
      expect(row({ ...transfer, note: 'а;б' })).toBe('2026-10-21;Перевод;10;UAH;0,25;;Основной;"а;б";Я;Наличные;10;UAH')
    })

    it('exchange: the received amount with a decimal comma and its currency', () => {
      expect(row(exchange)).toBe('2026-10-21;Обмен;1000;UAH;0,25;;Основной;;Я;Основной;24,5;USD')
    })

    it('exchange without a target account leaves «Счёт куда» empty', () => {
      expect(row({ ...exchange, to_account_id: null, note: 'в банке' })).toBe('2026-10-21;Обмен;1000;UAH;0,25;;Основной;в банке;Я;;24,5;USD')
    })

    it('other kinds leave the three columns empty', () => {
      expect(row({ kind: 'adjustment', amount: -3 })).toBe('2026-10-21;Корректировка;-3;UAH;0,25;;Основной;;Я;;;')
    })
  })

  it('quotes values containing «;», quotes or newlines CSV-style', () => {
    const csv = toCsv([tx({ note: 'a;b "c"\nd' })], [], [main], null)
    expect(csv).toContain('"a;b ""c""\nd"')
  })

  it('an unknown category or account gives an empty cell; no category is empty too', () => {
    const csv = toCsv([tx({ category_id: 'gone', account_id: 'gone' })], [cafe], [main], null)
    expect(lines(csv)[1]).toBe('2026-10-21;Расход;10;UAH;0,25;;;;Я;;;')
  })

  it('keeps archived categories and accounts resolvable', () => {
    const csv = toCsv([tx({ category_id: 'c1' })], [{ ...cafe, archived: true }], [{ ...main, archived: true }], null)
    expect(lines(csv)[1]).toContain(';Кафе и рестораны;Основной;')
  })
})

describe('csvFileName', () => {
  it('is seafarer-budget-YYYY-MM-DD.csv', () => {
    expect(csvFileName('2026-10-21')).toBe('seafarer-budget-2026-10-21.csv')
  })
})

describe('downloadCsv (D3)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the blob URL alive for ~10 s before revoking it', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadCsv('a.csv', 'x')
    expect(click).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(9000)
    expect(revoke).toHaveBeenCalledWith('blob:x')
    click.mockRestore()
  })
})