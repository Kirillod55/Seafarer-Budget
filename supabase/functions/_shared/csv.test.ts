import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from './types.ts'
import { parseCsv, planImport, toCsv } from './csv.ts'

const food = { id: 'c1', name: 'Продукты', kind: 'expense', icon: '🛒', keywords: [], archived: false, sort: 1, deleted: false, color: null, glyph: null, deleted_at: null, deleted_batch: null } as Category
const salary = { id: 'c2', name: 'Зарплата', kind: 'income', icon: '💰', keywords: [], archived: false, sort: 2, deleted: false, color: null, glyph: null, deleted_at: null, deleted_batch: null } as Category
const main = { id: 'a1', name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0, deleted: false } as Account

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
    category_id: 'c1',
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
  it('toCsv adds «Кто»', () => {
    const csv = toCsv(
      [
        tx({ id: 'o', author: 'owner', note: 'моё' }),
        tx({ id: 'p', author: 'partner', note: 'её' }),
        tx({ id: 'd', author: 'partner', note: 'удалено', deleted_at: '2026-10-22T00:00:00Z' }),
      ],
      [food],
      [main],
      'Маша',
    )
    const rows = lines(csv)
    expect(rows[0]).toBe('Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка;Кто')
    expect(rows).toHaveLength(3)
    expect(rows[1].split(';').at(-1)).toBe('Я')
    expect(rows[2].split(';').at(-1)).toBe('Маша')
    expect(csv).not.toContain('удалено')
  })

  it('names the second person «Она» when no name is set', () => {
    const csv = toCsv([tx({ author: 'partner' })], [food], [main], null)
    expect(lines(csv)[1].split(';').at(-1)).toBe('Она')
  })
})

describe('parseCsv', () => {
  it('accepts comma separator and DD.MM.YYYY', () => {
    const { rows, errors } = parseCsv(
      'Дата,Тип,Сумма,Валюта,Категория,Заметка\n21.10.2026,Расход,"1 200,50",UAH,Продукты,Атб',
      null,
    )
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ line: 2, amount: 1200.5, date: '2026-10-21', kind: 'expense', currency: 'UAH', category: 'Продукты', note: 'Атб', author: 'owner' })
  })

  it('strips the BOM and reads columns by name in any order', () => {
    const { rows } = parseCsv('﻿Сумма;Дата;Заметка\r\n5,5;2026-10-21;кофе\r\n', null)
    expect(rows[0]).toMatchObject({ amount: 5.5, date: '2026-10-21', note: 'кофе', kind: 'expense', currency: 'UAH', author: 'owner', category: '', account: '' })
  })

  it('bad rows are reported by line', () => {
    const { rows, errors } = parseCsv('Дата;Сумма\n2026-10-21;5\n2026-10-22;\n2026-10-23;7', null)
    expect(rows.map((r) => r.line)).toEqual([2, 4])
    expect(errors).toHaveLength(1)
    expect(errors[0].line).toBe(3)
  })

  it('reports a missing or invalid date and amount', () => {
    const { rows, errors } = parseCsv('Дата;Сумма\n;5\n31.02.2026;5\n2026-10-21;abc\n2026-10-21;0', null)
    expect(rows).toEqual([])
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5])
  })

  it('does not load transfers, exchanges and adjustments', () => {
    const { rows, errors } = parseCsv('Дата;Тип;Сумма\n2026-10-21;Перевод;5\n2026-10-21;Обмен;5\n2026-10-21;Корректировка;5\n2026-10-21;Доход;5', null)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('income')
    expect(errors).toEqual([
      { line: 2, reason: 'Этот тип не загружается' },
      { line: 3, reason: 'Этот тип не загружается' },
      { line: 4, reason: 'Этот тип не загружается' },
    ])
  })

  it('maps «Кто»: Я and empty are owner, the partner name is partner', () => {
    const { rows, errors } = parseCsv('Дата;Сумма;Кто\n2026-10-21;1;Я\n2026-10-21;2;\n2026-10-21;3;Маша\n2026-10-21;4;Кто-то', 'Маша')
    expect(rows.map((r) => r.author)).toEqual(['owner', 'owner', 'partner'])
    expect(errors.map((e) => e.line)).toEqual([5])
  })

  it('«Она» is the partner when no name is set', () => {
    expect(parseCsv('Дата;Сумма;Кто\n2026-10-21;1;Она', null).rows[0].author).toBe('partner')
  })

  it('keeps quoted separators, quotes and line breaks inside a cell; counts physical lines', () => {
    const { rows, errors } = parseCsv('Дата;Сумма;Заметка\n2026-10-21;1;"а;б ""в""\nг"\n2026-10-21;;x', null)
    expect(rows[0].note).toBe('а;б "в"\nг')
    expect(errors[0].line).toBe(4)
  })

  it('reports a missing required column', () => {
    const { rows, errors } = parseCsv('Тип;Заметка\nРасход;x', null)
    expect(rows).toEqual([])
    expect(errors[0].line).toBe(1)
  })

  it('reads amounts with a space, nbsp, comma or dot decimal', () => {
    const { rows } = parseCsv('Дата;Сумма\n2026-10-21;1 200,50\n2026-10-21;1 200.5\n2026-10-21;12', null)
    expect(rows.map((r) => r.amount)).toEqual([1200.5, 1200.5, 12])
  })
})

describe('planImport', () => {
  it('round trip', () => {
    const txs = [
      tx({ id: '1', amount: 1200.5, note: 'Атб; "акция"', category_id: 'c1' }),
      tx({ id: '2', amount: 0.99, author: 'partner', category_id: 'c1', date: '2026-10-20' }),
      tx({ id: '3', kind: 'income', amount: 33333.33, category_id: 'c2', currency: 'USD', author: 'partner', note: 'аванс' }),
      tx({ id: '4', amount: 7, category_id: null }),
    ]
    const { rows, errors } = parseCsv(toCsv(txs, [food, salary], [main], 'Маша'), 'Маша')
    expect(errors).toEqual([])
    const plan = planImport(rows, txs, [food, salary], [main])
    expect(plan.fresh.length).toBe(0)
    expect(plan.duplicates.length).toBe(txs.length)
    expect(plan.unknownCategories).toEqual([])
  })

  it('compares amounts to the cent and notes after trimming', () => {
    const { rows } = parseCsv('Дата;Сумма;Категория;Заметка\n2026-10-21;"1 200,50";Продукты; Атб ', null)
    expect(planImport(rows, [tx({ amount: 1200.5, note: 'Атб' })], [food], [main]).duplicates).toHaveLength(1)
  })

  it('differs by author, kind, currency, category, note, date or amount', () => {
    const base = tx({ amount: 10, note: 'x' })
    const csv = (cols: string) => parseCsv(`Дата;Тип;Сумма;Валюта;Категория;Заметка;Кто\n${cols}`, 'Маша').rows
    const plan = (cols: string) => planImport(csv(cols), [base], [food, salary], [main])
    expect(plan('2026-10-21;Расход;10;UAH;Продукты;x;Я').duplicates).toHaveLength(1)
    for (const other of [
      '2026-10-21;Расход;10;UAH;Продукты;x;Маша',
      '2026-10-21;Доход;10;UAH;Продукты;x;Я',
      '2026-10-21;Расход;10;USD;Продукты;x;Я',
      '2026-10-21;Расход;10;UAH;Зарплата;x;Я',
      '2026-10-21;Расход;10;UAH;Продукты;y;Я',
      '2026-10-22;Расход;10;UAH;Продукты;x;Я',
      '2026-10-21;Расход;10,01;UAH;Продукты;x;Я',
    ]) {
      expect(plan(other).fresh, other).toHaveLength(1)
    }
  })

  it('does not treat deleted or bin records as duplicates', () => {
    const { rows } = parseCsv('Дата;Сумма;Категория\n2026-10-21;10;Продукты', null)
    const plan = planImport(rows, [tx({ deleted: true }), tx({ deleted_at: '2026-10-22T00:00:00Z' })], [food], [main])
    expect(plan.fresh).toHaveLength(1)
  })

  it('unknown category is listed once', () => {
    const { rows } = parseCsv('Дата;Сумма;Категория\n2026-10-21;1;Кино\n2026-10-22;2;Кино\n2026-10-23;3;Продукты\n2026-10-24;4;\n2026-10-25;5;Книги', null)
    const plan = planImport(rows, [], [food, { ...salary, deleted_at: '2026-10-22T00:00:00Z' }], [main])
    expect(plan.unknownCategories).toEqual(['Кино', 'Книги'])
    expect(plan.fresh).toHaveLength(5)
  })
})
