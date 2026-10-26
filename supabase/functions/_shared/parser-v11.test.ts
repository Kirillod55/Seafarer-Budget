import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from './defaults.ts'
import { accountKey, damerau, layoutSwap } from './fuzzy.ts'
import { parseMessage } from './parser.ts'
import type { ParseContext, TxParsed } from './parser.ts'
import type { Account, Category } from './types.ts'

const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c, id: c.name, deleted: false }))
const acc = (name: string, sort: number, aliases: string[] = []): Account => ({
  id: name, name, aliases, is_default: sort === 0, archived: false, sort, deleted: false,
})
const accounts = [acc('Основной', 0), acc('Наличные', 1, ['нал']), acc('ProCreditBank', 2), acc('Пивденный', 3), acc('Monobank', 4)]

// 2026-10-21 is a Wednesday
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  currencies: ['UAH', 'USD', 'EUR', 'MDL'], defaultCurrency: 'UAH', categories, accounts, accountsMode: 'multi',
  today: '2026-10-21', ...over,
})
const tx = (text: string, over: Partial<ParseContext> = {}): TxParsed => {
  const p = parseMessage(text, ctx(over))
  if (p.type !== 'tx') throw new Error(`expected tx for «${text}», got ${JSON.stringify(p)}`)
  return p
}

describe('currency synonyms and typos (spec §5)', () => {
  it.each([
    ['кофе 50 гр', 'UAH'], ['кофе 50 гривень', 'UAH'], ['кофе 50 hrn', 'UAH'], ['кофе 50 dollars', 'USD'],
    ['кофе 50 евриков', 'EUR'], ['кофе 50 леи', 'MDL'], ['кофе 50 ley', 'MDL'],
    ['кофе 50$', 'USD'], ['кофе 50 $', 'USD'], ['кофе $50', 'USD'], ['кофе $ 50', 'USD'], ['кофе 12,50$', 'USD'],
    ['кофе 50 €', 'EUR'], ['кофе ₴ 50', 'UAH'], ['кофе 50L', 'MDL'], ['кофе 50 L', 'MDL'],
  ])('%s -> %s (exact)', (t, code) => {
    const p = tx(t)
    expect(p.currency).toBe(code)
    expect(p.currencyGuess).toBeNull()
  })

  it.each([
    ['кофе 50grн', 'UAH', 'grн'], ['кофе 50 grivna', 'UAH', 'grivna'], ['кофе 50 uhy', 'UAH', 'uhy'],
    ['кофе 50 грнн', 'UAH', 'грнн'], ['кофе 50 eru', 'EUR', 'eru'], ['кофе 50 евра', 'EUR', 'евра'],
    ['кофе 50 лэй', 'MDL', 'лэй'],
  ])('%s -> %s (guessed from «%s»)', (t, code, word) => {
    const p = tx(t)
    expect(p.currency).toBe(code)
    expect(p.currencyGuess).toEqual({ word, code })
    expect(p.note).toBe('кофе')
  })

  it('no false currencies: бар 30, кофе 80, дом 500', () => {
    expect(tx('бар 30')).toMatchObject({ currency: 'UAH', note: 'бар' })
    expect(tx('кофе 80')).toMatchObject({ currency: 'UAH', currencyGuess: null })
    expect(tx('дом 500')).toMatchObject({ currency: 'UAH', note: 'дом' })
  })
})

describe('number words and slang', () => {
  it.each([
    ['кофе восемьдесят', 80], ['продукты тысяча двести', 1200], ['такси сто пятьдесят', 150], ['кофе полтора', 1.5],
    ['такси сотка', 100], ['кофе полтос', 50], ['телефон косарь', 1000], ['телефон 2к', 2000], ['интернет пол косаря', 500],
  ])('%s -> %d', (t, amount) => expect(tx(t).amount).toBe(amount))
})

describe('dates', () => {
  it.each([
    ['позавчера кофе 80', '2026-10-19'], ['21.10 кофе 80', '2026-10-21'], ['20.10.26 кофе 80', '2026-10-20'],
    ['кофе 80 19.10.2026', '2026-10-19'], ['кофе 80 21 октября', '2026-10-21'], ['кофе 80 в пятницу', '2026-10-16'],
    ['пятница кофе 80', '2026-10-16'], ['пт кофе 80', '2026-10-16'], ['кофе 80 в среду', '2026-10-21'],
    ['вчора кава 80', '2026-10-20'],
  ])('%s -> %s', (t, date) => {
    const p = tx(t)
    expect(p.date).toBe(date)
    expect(p.amount).toBe(80)
    expect(p.dateGiven).toBe(true)
  })

  it('кофе 21.10 stays an amount of 21.10', () => {
    expect(tx('кофе 21.10')).toMatchObject({ amount: 21.1, date: '2026-10-21', dateGiven: false })
  })

  it('a future date is refused', () => {
    expect(parseMessage('25.10 кофе 80', ctx())).toEqual({ type: 'error', reason: 'future' })
    expect(parseMessage('кофе 80 25 октября', ctx())).toEqual({ type: 'error', reason: 'future' })
  })
})

describe('quantity', () => {
  it.each([
    ['2 кофе по 50', 100, 'Кофе ×2 по ₴50'], ['кофе 2 по 50', 100, 'Кофе ×2 по ₴50'], ['кофе 2×50', 100, 'Кофе ×2 по ₴50'],
    ['кофе 2x50', 100, 'Кофе ×2 по ₴50'], ['кофе 2*50', 100, 'Кофе ×2 по ₴50'],
    ['две пачки сигарет по 30', 60, 'Пачки сигарет ×2 по ₴30'],
  ])('%s -> %d «%s»', (t, amount, note) => {
    const p = tx(t)
    expect(p.amount).toBe(amount)
    expect(p.note).toBe(note)
    expect(p.quantity?.count).toBe(2)
  })

  it('without «по» / × the first number is the amount; 1 200 is one amount', () => {
    expect(tx('2 кофе 50')).toMatchObject({ amount: 2, quantity: null })
    expect(tx('кофе 1 200').amount).toBe(1200)
  })
})

describe('fuzzy account (spec §5, §9 «Узнавание счёта»)', () => {
  it('keys', () => {
    expect(accountKey('ProCreditBank')).toBe('prokredit')
    expect(accountKey('прокредит банк')).toBe('prokredit')
    expect(damerau('ab', 'ba')).toBe(1)
    expect(layoutSwap('ghjrhtlbn')).toBe('прокредит')
  })

  it.each([
    ['прокредит', 'ProCreditBank'], ['procredit', 'ProCreditBank'], ['прокредитбанк', 'ProCreditBank'],
    ['прокредт', 'ProCreditBank'], ['про кредит', 'ProCreditBank'], ['ghjrhtlbn', 'ProCreditBank'],
    ['пивденный', 'Пивденный'], ['південний', 'Пивденный'], ['pivdennyi', 'Пивденный'], ['пивдений', 'Пивденный'],
    ['моно', 'Monobank'], ['монобанк', 'Monobank'], ['mono', 'Monobank'],
  ])('кофе 80 %s -> %s', (word, id) => {
    const p = tx(`кофе 80 ${word}`)
    expect(p.accountId).toBe(id)
    expect(p.note).toBe('кофе')
  })

  it('not accounts: кофе, такси, гр, 50 and short words', () => {
    for (const t of ['кофе 80', 'такси 80', 'кофе 80 гр', 'кофе 80 мон', 'чай 80 сок']) expect(tx(t).accountId).toBeNull()
  })

  it('a word that fits two accounts picks none; exact beats fuzzy; archived accounts are not found', () => {
    const twins = [acc('Основной', 0), acc('Monobank', 1), acc('Monoblock', 2)]
    expect(tx('кофе 80 mono', { accounts: twins })).toMatchObject({ accountId: null, accountAmbiguous: true })
    const exact = [acc('Основной', 0), acc('Моно', 1), acc('Monobank', 2)]
    expect(tx('кофе 80 моно', { accounts: exact }).accountId).toBe('Моно')
    const archived = [acc('Основной', 0), { ...acc('Monobank', 1), archived: true }]
    expect(tx('кофе 80 моно', { accounts: archived }).accountId).toBeNull()
  })
})

describe('built-in dictionary', () => {
  it.each([
    ['атб 420', 'Продукты'], ['bolt 150', 'Транспорт и такси'], ['kfc 300', 'Кафе и рестораны'], ['linella 200', 'Продукты'],
    ['стики 300', 'Продукты'], ['сиги 75', 'Продукты'], ['картриджи 400', 'Продукты'], ['жижа 250', 'Продукты'],
    ['киевстар 200', 'Связь и интернет'], ['silpo 300', 'Продукты'],
  ])('%s -> %s', (t, cat) => expect(tx(t, { accountsMode: 'single' }).categoryId).toBe(cat))

  it('a learned word beats the dictionary', () => {
    const cats = categories.map((c) => (c.name === 'Развлечения' ? { ...c, keywords: [...c.keywords, 'стики'] } : c))
    expect(tx('стики 300', { categories: cats }).categoryId).toBe('Развлечения')
  })
})
