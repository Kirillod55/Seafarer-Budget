import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from './defaults.ts'
import { CURRENCY_ALIASES, parseMessage } from './parser.ts'
import type { ParseContext } from './parser.ts'
import type { Account, Category } from './types.ts'

const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c, id: c.name, deleted: false }))

const accounts: Account[] = [
  { id: 'Основной', name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0, deleted: false },
  { id: 'Наличные', name: 'Наличные', aliases: ['нал'], is_default: false, archived: false, sort: 1, deleted: false },
]

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  currencies: ['UAH', 'USD', 'EUR', 'MDL'],
  defaultCurrency: 'UAH',
  categories,
  accounts,
  accountsMode: 'single',
  today: '2026-10-21',
  ...over,
})

function tx(text: string, over: Partial<ParseContext> = {}) {
  const p = parseMessage(text, ctx(over))
  if (p.type !== 'tx') throw new Error(`expected tx, got ${JSON.stringify(p)}`)
  return p
}

describe('parseMessage: transactions', () => {
  it('кофе 80', () => {
    expect(tx('кофе 80')).toEqual({
      type: 'tx',
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      categoryId: 'Кафе и рестораны',
      accountId: null,
      date: '2026-10-21',
      note: 'кофе',
      firstWord: 'кофе',
    })
  })

  it('такси 15 eur', () => {
    const p = tx('такси 15 eur')
    expect(p.amount).toBe(15)
    expect(p.currency).toBe('EUR')
    expect(p.categoryId).toBe('Транспорт и такси')
    expect(p.note).toBe('такси')
  })

  it.each(['продукты 250 лей', 'продукты 250 леев', '90 mdl кафе', '90 lei кафе'])('MDL: %s', (t) => {
    expect(tx(t).currency).toBe('MDL')
  })

  it('MDL amounts and categories', () => {
    expect(tx('продукты 250 лей')).toMatchObject({ amount: 250, categoryId: 'Продукты', note: 'продукты' })
    expect(tx('90 mdl кафе')).toMatchObject({ amount: 90, categoryId: 'Кафе и рестораны', note: 'кафе' })
  })

  it('single-letter l only when glued to the number', () => {
    expect(tx('кафе 90l').currency).toBe('MDL')
    const p = tx('кафе 90 l')
    expect(p.currency).toBe('UAH')
    expect(p.note).toBe('кафе l')
  })

  it('glued currencies and decimal/thousands', () => {
    expect(tx('кофе 80грн')).toMatchObject({ amount: 80, currency: 'UAH' })
    expect(tx('$15 такси')).toMatchObject({ amount: 15, currency: 'USD', note: 'такси' })
    expect(tx('такси 15$')).toMatchObject({ amount: 15, currency: 'USD', note: 'такси' })
    expect(tx('ремонт 1 200 грн')).toMatchObject({ amount: 1200, currency: 'UAH', note: 'ремонт' })
    expect(tx('обед 12,50 eur')).toMatchObject({ amount: 12.5, currency: 'EUR' })
    expect(tx('обед 12.50 €')).toMatchObject({ amount: 12.5, currency: 'EUR' })
    expect(tx('кофе ₴80')).toMatchObject({ amount: 80, currency: 'UAH' })
  })

  it('thousands: a group followed by exactly 3 digits', () => {
    expect(tx('ремонт 1 200').amount).toBe(1200)
    expect(tx('ремонт 12 345').amount).toBe(12345)
  })

  it('M3: repeated 3-digit groups merge', () => {
    expect(tx('квартира 1 200 000 грн')).toMatchObject({ amount: 1200000, currency: 'UAH', note: 'квартира' })
    expect(tx('квартира 1 200 000')).toMatchObject({ amount: 1200000, note: 'квартира' })
    expect(tx('машина 12 345 678,50 usd')).toMatchObject({ amount: 12345678.5, currency: 'USD', note: 'машина' })
    expect(tx('ремонт 1 200 000грн')).toMatchObject({ amount: 1200000, currency: 'UAH' })
    // a decimal part ends the number: the next group is not merged
    expect(tx('ремонт 1 200,50 300')).toMatchObject({ amount: 1200.5, note: 'ремонт 300' })
  })

  it('I5: Авто no longer catches «стоматолог» / «столовая»; «шиномонтаж» and «шины» are Авто', () => {
    expect(tx('стоматолог 500').categoryId).not.toBe('Авто')
    expect(tx('столовая 120').categoryId).not.toBe('Авто')
    expect(tx('шиномонтаж 300').categoryId).toBe('Авто')
    expect(tx('шины 3000').categoryId).toBe('Авто')
  })

  describe('I4: trailing punctuation', () => {
    it('такси 15 eur. -> 15 EUR', () => {
      expect(tx('такси 15 eur.')).toMatchObject({ amount: 15, currency: 'EUR', note: 'такси' })
    })
    it('кофе 80. -> 80 UAH', () => {
      expect(tx('кофе 80.')).toMatchObject({ amount: 80, currency: 'UAH', note: 'кофе' })
    })
    it('кофе 80!', () => {
      expect(tx('кофе 80!')).toMatchObject({ amount: 80, currency: 'UAH', note: 'кофе' })
    })
    it('80 грн, кофе', () => {
      expect(tx('80 грн, кофе')).toMatchObject({ amount: 80, currency: 'UAH', note: 'кофе', categoryId: 'Кафе и рестораны' })
    })
    it('кофе 80 грн,', () => {
      expect(tx('кофе 80 грн,')).toMatchObject({ amount: 80, currency: 'UAH', note: 'кофе' })
    })
    it('glued currency with punctuation: кофе 80грн.', () => {
      expect(tx('кофе 80грн.')).toMatchObject({ amount: 80, currency: 'UAH' })
    })
    it('decimal separators inside numbers still work', () => {
      expect(tx('обед 12,50 eur')).toMatchObject({ amount: 12.5, currency: 'EUR' })
      expect(tx('обед 80.5')).toMatchObject({ amount: 80.5 })
      expect(tx('обед 80.5.')).toMatchObject({ amount: 80.5 })
      expect(tx('ремонт 1 200.')).toMatchObject({ amount: 1200 })
    })
  })

  it('a group of 1-3 digits followed by a non-3-digit group is not thousands', () => {
    // amount is the first number; the second one stays in the note
    const p = tx('кофе 80 20')
    expect(p.amount).toBe(80)
    expect(p.note).toBe('кофе 20')
  })

  it('income: +3000 usd and зп 3000 usd', () => {
    expect(tx('+3000 usd')).toMatchObject({
      kind: 'income',
      amount: 3000,
      currency: 'USD',
      categoryId: 'Зарплата',
    })
    expect(tx('зп 3000 usd')).toMatchObject({
      kind: 'income',
      amount: 3000,
      currency: 'USD',
      categoryId: 'Зарплата',
      note: 'зп',
    })
  })

  it('+ matches only income categories; an expense word falls back to the first income category', () => {
    expect(tx('+500 доход')).toMatchObject({ kind: 'income', categoryId: 'Прочий доход' })
    expect(tx('+500 кофе')).toMatchObject({ kind: 'income', categoryId: 'Зарплата', note: 'кофе' })
  })

  it('exact keyword beats prefix matches ("авто" is Авто, not автобус)', () => {
    expect(tx('авто 500').categoryId).toBe('Авто')
  })

  it('a lone + before the number and a currency word after', () => {
    expect(tx('+ 3000 usd')).toMatchObject({ kind: 'income', amount: 3000, currency: 'USD' })
  })

  it('вчера shifts the date', () => {
    const p = tx('вчера кофе 80')
    expect(p.date).toBe('2026-10-20')
    expect(p.note).toBe('кофе')
  })

  it('accounts in multi mode', () => {
    const p = tx('кофе 80 нал', { accountsMode: 'multi' })
    expect(p.accountId).toBe('Наличные')
    expect(p.note).toBe('кофе')
    expect(tx('кофе 80 Наличные', { accountsMode: 'multi' }).accountId).toBe('Наличные')
  })

  it('accounts in single mode stay in the note', () => {
    const p = tx('кофе 80 нал')
    expect(p.accountId).toBeNull()
    expect(p.note).toBe('кофе нал')
  })

  it('unknown word: categoryId null, firstWord kept', () => {
    expect(tx('непонятное 50')).toMatchObject({
      kind: 'expense',
      categoryId: null,
      firstWord: 'непонятное',
      note: 'непонятное',
    })
  })

  it('no note at all', () => {
    expect(tx('80')).toMatchObject({ categoryId: null, note: '', firstWord: null })
  })

  it('R2: + with no matching word is income / first income category', () => {
    expect(tx('+3000')).toMatchObject({ kind: 'income', categoryId: 'Зарплата' })
    expect(tx('+3000 непонятное')).toMatchObject({ kind: 'income', categoryId: 'Зарплата' })
  })

  it('R3 rule A: word starts with a keyword', () => {
    expect(tx('продукты 100').categoryId).toBe('Продукты') // продукты starts with продукт
    expect(tx('кофейня 100').categoryId).toBe('Кафе и рестораны')
  })

  it('R3 rule B: keyword starts with the word, only when word length >= 3', () => {
    expect(tx('ресто 100').categoryId).toBe('Кафе и рестораны')
    expect(tx('ре 100').categoryId).toBeNull()
  })

  it('first matching word wins, in order of words', () => {
    expect(tx('такси кофе 100').categoryId).toBe('Транспорт и такси')
    expect(tx('кофе такси 100').categoryId).toBe('Кафе и рестораны')
  })

  it('ignores archived and deleted categories', () => {
    const cats = categories.map((c) =>
      c.name === 'Кафе и рестораны' ? { ...c, archived: true } : c.name === 'Транспорт и такси' ? { ...c, deleted: true } : c,
    )
    expect(tx('кофе 80', { categories: cats }).categoryId).toBeNull()
    expect(tx('такси 80', { categories: cats }).categoryId).toBeNull()
  })

  it('only recognises currencies in ctx.currencies', () => {
    const p = tx('такси 15 eur', { currencies: ['UAH', 'USD'] })
    expect(p.currency).toBe('UAH')
    expect(p.note).toBe('такси eur')
  })

  it('case-insensitive', () => {
    expect(tx('Кофе 80 ГРН')).toMatchObject({ amount: 80, currency: 'UAH', note: 'кофе' })
  })

  it('other aliases', () => {
    expect(tx('кофе 5 долларов').currency).toBe('USD')
    expect(tx('кофе 5 баксов').currency).toBe('USD')
    expect(tx('кофе 5 евро').currency).toBe('EUR')
    expect(tx('кофе 5 гривен').currency).toBe('UAH')
  })
})

describe('parseMessage: goals', () => {
  it('цель машина 500', () => {
    expect(parseMessage('цель машина 500', ctx())).toEqual({
      type: 'goal',
      goalName: 'машина',
      amount: 500,
      currency: 'UAH',
      date: '2026-10-21',
    })
  })

  it('цель машина -200 usd', () => {
    expect(parseMessage('цель машина -200 usd', ctx())).toEqual({
      type: 'goal',
      goalName: 'машина',
      amount: -200,
      currency: 'USD',
      date: '2026-10-21',
    })
  })

  it('multi-word goal name', () => {
    expect(parseMessage('цель новая машина 500', ctx())).toMatchObject({ goalName: 'новая машина', amount: 500 })
  })
})

describe('parseMessage: commands and errors', () => {
  it.each([
    ['сегодня', 'today'],
    ['месяц', 'month'],
    ['остаток', 'left'],
    ['/left', 'left'],
    ['отмена', 'undo'],
    ['/undo', 'undo'],
    ['помощь', 'help'],
    ['/help', 'help'],
    ['/today', 'today'],
    ['/month', 'month'],
  ])('%s -> %s', (t, command) => {
    expect(parseMessage(t, ctx())).toEqual({ type: 'command', command })
  })

  it('кофе -> error no_amount', () => {
    expect(parseMessage('кофе', ctx())).toEqual({ type: 'error', reason: 'no_amount' })
  })

  it('empty -> error no_amount', () => {
    expect(parseMessage('   ', ctx())).toEqual({ type: 'error', reason: 'no_amount' })
  })
})

describe('CURRENCY_ALIASES', () => {
  it('has the four currencies', () => {
    expect(Object.keys(CURRENCY_ALIASES).sort()).toEqual(['EUR', 'MDL', 'UAH', 'USD'])
  })
})
