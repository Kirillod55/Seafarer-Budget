import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from './types.ts'
import { parseCsv, planImport, toCsv } from './csv.ts'

const food = { id: 'c1', name: 'Продукты', kind: 'expense', icon: '🛒', keywords: [], archived: false, sort: 1, deleted: false, color: null, glyph: null, deleted_at: null, deleted_batch: null } as Category
const salary = { id: 'c2', name: 'Зарплата', kind: 'income', icon: '💰', keywords: [], archived: false, sort: 2, deleted: false, color: null, glyph: null, deleted_at: null, deleted_batch: null } as Category
const main = { id: 'a1', name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0, deleted: false } as Account
const card = { id: 'a2', name: 'Карта', aliases: [], is_default: false, archived: false, sort: 1, deleted: false } as Account
const HEADER = 'Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка;Кто;Счёт куда;Сумма куда;Валюта куда'

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
    expect(rows[0]).toBe(HEADER)
    expect(rows).toHaveLength(3)
    expect(rows[1].split(';')[8]).toBe('Я')
    expect(rows[2].split(';')[8]).toBe('Маша')
    expect(csv).not.toContain('удалено')
  })

  it('names the second person «Она» when no name is set', () => {
    const csv = toCsv([tx({ author: 'partner' })], [food], [main], null)
    expect(lines(csv)[1].split(';')[8]).toBe('Она')
    // a name with stray spaces is trimmed, a blank one falls back to «Она»
    expect(lines(toCsv([tx({ author: 'partner' })], [food], [main], '  Маша '))[1].split(';')[8]).toBe('Маша')
    expect(lines(toCsv([tx({ author: 'partner' })], [food], [main], '   '))[1].split(';')[8]).toBe('Она')
  })

  // I5 (final review): the Sunday CSV is the disaster-recovery copy, so the second leg has columns of its own
  it('writes the second leg of a transfer / exchange to «Счёт куда; Сумма куда; Валюта куда», not into the note', () => {
    const csv = toCsv(
      [
        tx({ id: 'e', note: 'кофе' }),
        tx({ id: 't', kind: 'transfer', amount: 100, currency: 'UAH', category_id: null, to_account_id: 'a2', note: 'на карту' }),
        tx({ id: 'x', kind: 'exchange', amount: 4150, currency: 'UAH', category_id: null, to_account_id: 'a1', to_amount: 100.5, to_currency: 'USD', note: '' }),
        tx({ id: 'c', kind: 'adjustment', amount: -12.5, category_id: null, note: 'Начальный остаток' }),
      ],
      [food],
      [main, card],
      null,
    )
    const [, e, t, x, c] = lines(csv).map((l) => l.split(';'))
    expect(e.slice(7)).toEqual(['кофе', 'Я', '', '', ''])
    expect(t).toEqual(['2026-10-21', 'Перевод', '100', 'UAH', '0,25', '', 'Основной', 'на карту', 'Я', 'Карта', '100', 'UAH'])
    expect(x.slice(1, 4)).toEqual(['Обмен', '4150', 'UAH'])
    expect(x.slice(6)).toEqual(['Основной', '', 'Я', 'Основной', '100,5', 'USD'])
    expect(c.slice(1, 3)).toEqual(['Корректировка', '-12,5'])
    expect(c.slice(7)).toEqual(['Начальный остаток', 'Я', '', '', ''])
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

  it('loads corrections (signed), transfers and exchanges with their second leg', () => {
    const { rows, errors } = parseCsv(
      [
        'Дата;Тип;Сумма;Валюта;Категория;Счёт;Заметка;Счёт куда;Сумма куда;Валюта куда',
        '2026-10-21;Корректировка;-12,5;UAH;Продукты;Карта;минус;;;',
        '2026-10-21;Корректировка;+3;USD;;;плюс;;;',
        '2026-10-21;Перевод;100;UAH;;Основной;на карту;Карта;100;UAH',
        '2026-10-21;Перевод;5;UAH;;Основной;без суммы куда;Карта;;',
        '2026-10-21;Обмен;4150;UAH;;Основной;;;100,5;USD',
      ].join('\n'),
      null,
    )
    expect(errors).toEqual([])
    expect(rows.map((r) => [r.kind, r.amount, r.currency, r.account, r.toAccount, r.toAmount, r.toCurrency, r.category])).toEqual([
      ['adjustment', -12.5, 'UAH', 'Карта', '', null, null, ''],
      ['adjustment', 3, 'USD', '', '', null, null, ''],
      ['transfer', 100, 'UAH', 'Основной', 'Карта', null, null, ''],
      ['transfer', 5, 'UAH', 'Основной', 'Карта', null, null, ''],
      ['exchange', 4150, 'UAH', 'Основной', '', 100.5, 'USD', ''],
    ])
  })

  it('reports a transfer without «Счёт куда» or into another currency, an exchange without its second leg', () => {
    const { rows, errors } = parseCsv(
      [
        'Дата;Тип;Сумма;Валюта;Счёт;Счёт куда;Сумма куда;Валюта куда',
        '2026-10-21;Перевод;100;UAH;Основной;;;',
        '2026-10-21;Перевод;100;UAH;Основной;Карта;3;USD',
        '2026-10-21;Обмен;100;UAH;Основной;;;USD',
        '2026-10-21;Обмен;100;UAH;Основной;;abc;USD',
        '2026-10-21;Обмен;100;UAH;Основной;;3;',
        '2026-10-21;Обмен;100;UAH;Основной;;3;UAH',
        '2026-10-21;Расход;-5;UAH;;;;',
      ].join('\n'),
      null,
    )
    expect(rows).toEqual([])
    expect(errors).toEqual([
      { line: 2, reason: 'Нет счёта «куда»' },
      { line: 3, reason: 'Перевод в другую валюту — это обмен' },
      { line: 4, reason: 'Нет суммы «куда»' },
      { line: 5, reason: 'Непонятная сумма «куда»' },
      { line: 6, reason: 'Нет валюты «куда»' },
      { line: 7, reason: 'Обмен в ту же валюту' },
      { line: 8, reason: 'Непонятная сумма' },
    ])
  })

  it('reads the currency as a 3-letter code or a known sign / word; anything else is an error', () => {
    const cases: [string, string][] = [
      ['₴', 'UAH'], ['грн', 'UAH'], ['Грн.', 'UAH'], ['гривна', 'UAH'],
      ['$', 'USD'], ['дол', 'USD'], ['€', 'EUR'], ['евро', 'EUR'],
      ['лей', 'MDL'], ['L', 'MDL'], ['usd', 'USD'], ['Pln', 'PLN'], ['', 'UAH'],
    ]
    const csv = 'Дата;Сумма;Валюта\n' + cases.map(([c]) => '2026-10-21;1;' + c).join('\n')
    const { rows, errors } = parseCsv(csv, null)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.currency)).toEqual(cases.map(([, code]) => code))
    for (const bad of ['доллары США', 'US', 'USDT', '12', 'грош']) {
      expect(parseCsv('Дата;Сумма;Валюта\n2026-10-21;1;' + bad, null).errors, bad).toEqual([{ line: 2, reason: 'Непонятная валюта' }])
    }
  })

  it('a quote opens a quoted cell only at the start of the cell', () => {
    const { rows, errors } = parseCsv('Дата;Сумма;Заметка\n2026-10-21;1;экран 5" дюймов\n2026-10-21;2;a"b;c', null)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.note)).toEqual(['экран 5" дюймов', 'a"b'])
  })

  it('skips records whose cells are all blank (Excel leaves «;;;» lines)', () => {
    const { rows, errors } = parseCsv('Дата;Сумма;Заметка\n2026-10-21;1;x\n;;\n  ;  ; \n2026-10-22;2;y\n;;\n', null)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.line)).toEqual([2, 5])
  })

  it('reads the header «Счет» as «Счёт» and trims the partner name', () => {
    const { rows } = parseCsv('Дата;Сумма;Счет;Счет куда;Кто\n2026-10-21;1;Карта;;Маша', '  Маша ')
    expect(rows[0]).toMatchObject({ account: 'Карта', author: 'partner' })
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
  it('round trip (expense and income)', () => {
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

  it('duplicates are matched as a multiset: two identical file rows against one record = 1 duplicate + 1 fresh', () => {
    const one = parseCsv('Дата;Сумма;Категория;Заметка\n2026-10-21;10;Продукты;x\n2026-10-21;10;Продукты;x', null).rows
    const plan1 = planImport(one, [tx({ id: '1', note: 'x' })], [food], [main])
    expect(plan1.duplicates.map((r) => r.line)).toEqual([2])
    expect(plan1.fresh.map((r) => r.line)).toEqual([3])
    const { rows } = parseCsv('Дата;Сумма;Категория;Заметка\n2026-10-21;10;Продукты;x\n2026-10-21;10;Продукты;x\n2026-10-21;10;Продукты;x', null)
    const plan = planImport(rows, [tx({ id: '1', note: 'x' }), tx({ id: '2', note: 'x' })], [food], [main])
    expect(plan.duplicates.map((r) => r.line)).toEqual([2, 3])
    expect(plan.fresh.map((r) => r.line)).toEqual([4])
  })

  it('compares category names case-insensitively', () => {
    const { rows } = parseCsv('Дата;Сумма;Категория\n2026-10-21;10;продукты\n2026-10-22;1;кино\n2026-10-23;1;КИНО', null)
    const plan = planImport(rows, [tx({ amount: 10 })], [food], [main])
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.unknownCategories).toEqual(['кино'])
  })

  it('lists unknown account names once (their rows go to the default account)', () => {
    const { rows } = parseCsv('Дата;Тип;Сумма;Счёт;Счёт куда\n2026-10-21;Расход;1;Карта;\n2026-10-21;Перевод;1;Сейф;Банка\n2026-10-21;Расход;1;Сейф;\n2026-10-21;Расход;1;;', null)
    expect(planImport(rows, [], [food], [main, card]).unknownAccounts).toEqual(['Сейф', 'Банка'])
  })

  it('round trip with every kind: corrections, transfers, exchanges, partner rows and kopecks are all duplicates', () => {
    const txs = [
      tx({ id: '1', amount: 1200.5, note: 'Атб; "акция"' }),
      tx({ id: '2', amount: 0.99, author: 'partner', date: '2026-10-20', account_id: 'a2' }),
      tx({ id: '3', kind: 'income', amount: 33333.33, category_id: 'c2', currency: 'USD', author: 'partner', note: 'аванс' }),
      tx({ id: '4', kind: 'adjustment', amount: 5000, category_id: null, note: 'Начальный остаток' }),
      tx({ id: '5', kind: 'adjustment', amount: -0.01, category_id: null, account_id: 'a2', author: 'partner' }),
      tx({ id: '6', kind: 'transfer', amount: 250.75, category_id: null, to_account_id: 'a2', note: 'на карту' }),
      tx({ id: '7', kind: 'exchange', amount: 4150, category_id: null, to_account_id: 'a1', to_amount: 100.5, to_currency: 'USD' }),
      tx({ id: '8', kind: 'exchange', amount: 20, currency: 'USD', category_id: null, account_id: 'a2', to_account_id: null, to_amount: 830, to_currency: 'UAH', author: 'partner' }),
      // the same expense twice: both lines of the file are duplicates (multiset)
      tx({ id: '9', amount: 7, category_id: null }),
      tx({ id: '10', amount: 7, category_id: null }),
    ]
    const { rows, errors } = parseCsv(toCsv(txs, [food, salary], [main, card], 'Маша'), 'Маша')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(txs.length)
    const plan = planImport(rows, txs, [food, salary], [main, card])
    expect(plan.fresh).toEqual([])
    expect(plan.duplicates).toHaveLength(txs.length)
    expect(plan.unknownCategories).toEqual([])
    expect(plan.unknownAccounts).toEqual([])
  })

  it('unknown category is listed once', () => {
    const { rows } = parseCsv('Дата;Сумма;Категория\n2026-10-21;1;Кино\n2026-10-22;2;Кино\n2026-10-23;3;Продукты\n2026-10-24;4;\n2026-10-25;5;Книги', null)
    const plan = planImport(rows, [], [food, { ...salary, deleted_at: '2026-10-22T00:00:00Z' }], [main])
    expect(plan.unknownCategories).toEqual(['Кино', 'Книги'])
    expect(plan.fresh).toHaveLength(5)
  })
})
