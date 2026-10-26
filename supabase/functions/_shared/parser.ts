// Free-text message parser: "кофе 80", "такси 15 eur", "+3000 usd", "цель машина 500", "вчера атб 420",
// "2 кофе по 50", "кофе 80 прокредит". Shared by the bot and the app's quick line. Pure TypeScript,
// no imports from npm (also runs in Deno). Several records in one message: multi.ts.
import { addDays } from './dates.ts'
import { DICTIONARY } from './dictionary.ts'
import { money } from './format.ts'
import { accountKey, damerau, keyMatches, latinToCyr, layoutSwap } from './fuzzy.ts'
import type { Account, Category } from './types.ts'
import { numberWords } from './words.ts'

export interface ParseContext {
  currencies: string[]
  defaultCurrency: string
  categories: Category[]
  accounts: Account[]
  accountsMode: 'single' | 'multi'
  today: string
}

export interface TxParsed {
  type: 'tx'
  kind: 'expense' | 'income'
  amount: number
  currency: string
  categoryId: string | null
  accountId: string | null
  date: string
  note: string
  firstWord: string | null
  /** the message named a date (вчера, 21.10, в пятницу…) */
  dateGiven?: boolean
  /** the currency was guessed from a misspelt word («gr» -> UAH): the reply says so */
  currencyGuess?: { word: string; code: string } | null
  /** a word looked like two accounts: nothing was picked, the bot shows account buttons */
  accountAmbiguous?: boolean
  /** «2 кофе по 50»: amount = count × price */
  quantity?: { count: number; price: number } | null
}

export type Parsed =
  | TxParsed
  | { type: 'goal'; goalName: string; amount: number; currency: string; date: string }
  | { type: 'command'; command: 'today' | 'month' | 'left' | 'undo' | 'help' }
  | { type: 'error'; reason: 'no_amount' | 'future' }

export const CURRENCY_ALIASES: Record<string, string[]> = {
  UAH: ['грн', 'гр', 'гривна', 'гривны', 'гривен', 'гривень', 'гривні', 'uah', 'grn', 'gr', 'hrn', 'hryvnia', '₴'],
  USD: ['usd', 'us', '$', 'дол', 'долл', 'доллар', 'доллара', 'долларов', 'бакс', 'бакса', 'баксов', 'dol', 'dollar', 'dollars'],
  EUR: ['eur', 'eu', '€', 'евро', 'евр', 'euro', 'evro', 'евриков'],
  MDL: ['лей', 'леев', 'лея', 'леи', 'lei', 'mdl', 'ley', 'l'],
}

/** Aliases valid only right next to the amount (`50L`, `50 L`, `80 гр`), never elsewhere in the text. */
const ADJACENT_ONLY = new Set(['l', 'гр', 'gr', 'us', 'eu'])
/** Never reached by a typo: «дом» is not «дол». */
const NO_TYPO = new Set(['дол', 'долл', 'dol'])

const COMMAND_WORDS: Record<string, 'today' | 'month' | 'left' | 'undo' | 'help'> = {
  'сегодня': 'today',
  'месяц': 'month',
  'остаток': 'left',
  'отмена': 'undo',
  'помощь': 'help',
}
const COMMAND_SLASH = /^\/(today|month|left|undo|help)(?:@\w+)?$/

const GOAL_WORD = 'цель'

// [sign][prefix symbol][number][glued suffix]
const AMOUNT_RE = /^([+-])?([₴$€]|l)?(\d+(?:[.,]\d+)?)([a-zа-яёіїєґ₴$€]+)?$/u
// integer part of 1-3 digits, nothing else: may be the head of "1 200"
const THOUSAND_HEAD_RE = /^([+-])?([₴$€]|l)?(\d{1,3})$/u
// exactly 3 digits, optional decimals and glued suffix: the tail of "1 200"
const THOUSAND_TAIL_RE = /^(\d{3}(?:[.,]\d+)?)([a-zа-яёіїєґ₴$€]+)?$/u
const FILLER = new Set(['-', '—', '–', ':', '='])

export interface Amount {
  index: number
  length: number // tokens consumed (2 when thousands were merged)
  value: number
  negative: boolean
  plus: boolean
  currency: string | null
  guess: { word: string; code: string } | null
}

export function stripPunct(word: string): string {
  return word.replace(/^[.,!?;:()"'«»]+|[.,!?;:()"'«»]+$/gu, '')
}

/** Lower case, single spaces, numbers written as words -> digits, lone dashes/colons dropped. */
export function normalize(text: string): string {
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim()
  return numberWords(lower)
    .split(' ')
    .filter((t) => t && !FILLER.has(t))
    .join(' ')
}

/** Enabled currencies: alias -> code. */
export function aliasMap(currencies: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    if (!currencies.includes(code)) continue
    for (const a of aliases) m.set(a, code)
  }
  return m
}

/**
 * The currency a word next to an amount means (spec §5 «Опечатки в валюте», step 2): exact alias,
 * else Latin look-alikes, the other keyboard layout, or one typo (words of 3+ letters).
 */
export function fuzzyCurrency(raw: string, aliases: Map<string, string>): { code: string; guessed: boolean } | null {
  const w = stripPunct(raw)
  if (!w) return null
  const exact = aliases.get(w)
  if (exact) return { code: exact, guessed: false }
  for (const v of [latinToCyr(w), layoutSwap(w)]) {
    const code = v ? aliases.get(v) : undefined
    if (code && v!.length >= 2) return { code, guessed: true }
  }
  if ([...w].length < 3 || /\d/.test(w)) return null
  for (const v of [w, latinToCyr(w)]) {
    for (const [alias, code] of aliases) {
      if ([...alias].length < 3 || NO_TYPO.has(alias)) continue
      if (damerau(v, alias) <= 1) return { code, guessed: true }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------
const MONTHS_GEN: Record<string, number> = {
  'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
  'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12, 'січня': 1, 'лютого': 2, 'березня': 3, 'квітня': 4,
  'травня': 5, 'червня': 6, 'липня': 7, 'серпня': 8, 'вересня': 9, 'жовтня': 10, 'листопада': 11, 'грудня': 12,
}
const WEEKDAYS: Record<string, number> = {
  'воскресенье': 0, 'вс': 0, 'неділя': 0, 'неділю': 0, 'нд': 0,
  'понедельник': 1, 'пн': 1, 'понеділок': 1,
  'вторник': 2, 'вт': 2, 'вівторок': 2,
  'среда': 3, 'среду': 3, 'ср': 3, 'середа': 3, 'середу': 3,
  'четверг': 4, 'чт': 4, 'четвер': 4,
  'пятница': 5, 'пятницу': 5, 'пт': 5, "п'ятниця": 5, "п'ятницю": 5,
  'суббота': 6, 'субботу': 6, 'сб': 6, 'субота': 6, 'суботу': 6,
}
const RELATIVE: Record<string, number> = {
  'сегодня': 0, 'сьогодні': 0, 'вчера': -1, 'вчора': -1, 'учора': -1, 'позавчера': -2, 'позавчора': -2,
}
const DMY_RE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return dt.toISOString().slice(0, 10)
}

function weekdayDate(dow: number, today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const todayDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return addDays(today, -((todayDow - dow + 7) % 7))
}

/**
 * The first date expression among the tokens: вчера / позавчера / сегодня, a weekday («в пятницу»,
 * «пт» — the latest such day, today included), «21 октября», «21.10[.26|.2026]» (a date only when
 * another number in the text can be the amount). Returns the tokens without it.
 */
export function takeDate(tokens: string[], today: string): { tokens: string[]; date: string | null } {
  for (let i = 0; i < tokens.length; i++) {
    const d = dateAt(tokens, i, today)
    if (d) return { tokens: [...tokens.slice(0, d.from), ...tokens.slice(d.to)], date: d.date }
  }
  return { tokens, date: null }
}

/** A date expression at token i: the date and the token range it covers (a preceding «в» included). */
export function dateAt(tokens: string[], i: number, today: string): { date: string; from: number; to: number } | null {
  const year = Number(today.slice(0, 4))
  const w = stripPunct(tokens[i])
  if (w in RELATIVE) return { date: addDays(today, RELATIVE[w]), from: i, to: i + 1 }
  if (w in WEEKDAYS) {
    const from = i > 0 && ['в', 'во', 'у'].includes(tokens[i - 1]) ? i - 1 : i
    return { date: weekdayDate(WEEKDAYS[w], today), from, to: i + 1 }
  }
  if (/^\d{1,2}$/.test(w) && stripPunct(tokens[i + 1] ?? '') in MONTHS_GEN) {
    const date = validDate(year, MONTHS_GEN[stripPunct(tokens[i + 1])], Number(w))
    return date ? { date, from: i, to: i + 2 } : null
  }
  const m = DMY_RE.exec(w)
  if (m && tokens.some((t, k) => k !== i && /\d/.test(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year
    const date = validDate(y, Number(m[2]), Number(m[1]))
    return date ? { date, from: i, to: i + 1 } : null
  }
  return null
}

/** Is this one token (or «в пятницу») just a date? Used for a date line / tail words in multi.ts. */
export function dateOf(words: string[], today: string): string | null {
  const r = takeDate(words, today)
  if (!r.date) {
    // «21.10» alone on its line is a date as well
    const m = words.length === 1 ? DMY_RE.exec(stripPunct(words[0])) : null
    if (!m) return null
    const year = Number(today.slice(0, 4))
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year
    return validDate(y, Number(m[2]), Number(m[1]))
  }
  return r.tokens.length === 0 ? r.date : null
}

// ---------------------------------------------------------------------------
// quantity: «2 кофе по 50», «кофе 2 по 50», «кофе 2x50», «кофе 2 × 50»
// ---------------------------------------------------------------------------
const TIMES = new Set(['x', 'х', '×', '*'])
const QTY_GLUED_RE = /^(\d{1,2})[xх×*](\d.*)$/u
const isCount = (t: string | undefined) => t !== undefined && /^\d{1,2}$/.test(t) && Number(t) >= 2 && Number(t) <= 99
const startsNumber = (t: string | undefined) => t !== undefined && /^[+]?[₴$€]?\d/.test(t)

export function takeQuantity(tokens: string[]): { tokens: string[]; count: number | null } {
  for (let i = 0; i < tokens.length; i++) {
    const g = QTY_GLUED_RE.exec(tokens[i])
    if (g && isCount(g[1])) return { tokens: [...tokens.slice(0, i), g[2], ...tokens.slice(i + 1)], count: Number(g[1]) }
    if (isCount(tokens[i]) && TIMES.has(tokens[i + 1] ?? '') && startsNumber(tokens[i + 2])) {
      return { tokens: [...tokens.slice(0, i), ...tokens.slice(i + 2)], count: Number(tokens[i]) }
    }
  }
  const p = tokens.findIndex((t, k) => t === 'по' && startsNumber(tokens[k + 1]))
  if (p > 0) {
    for (let i = p - 1; i >= 0; i--) {
      if (/\d/.test(tokens[i])) {
        if (!isCount(tokens[i])) break
        return { tokens: tokens.filter((_, k) => k !== i && k !== p), count: Number(tokens[i]) }
      }
    }
  }
  return { tokens, count: null }
}

// ---------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------
export function parseMessage(text: string, ctx: ParseContext): Parsed {
  const raw = text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!raw) return { type: 'error', reason: 'no_amount' }

  // commands: a single word
  const cmd = COMMAND_WORDS[raw]
  if (cmd) return { type: 'command', command: cmd }
  const slash = COMMAND_SLASH.exec(raw)
  if (slash) return { type: 'command', command: slash[1] as 'today' | 'month' | 'left' | 'undo' | 'help' }

  const aliasToCode = aliasMap(ctx.currencies)
  let tokens = normalize(raw).split(' ').filter(Boolean)

  let isGoal = false
  if (tokens[0] === GOAL_WORD) {
    isGoal = true
    tokens = tokens.slice(1)
  }

  const d = takeDate(tokens, ctx.today)
  tokens = d.tokens
  const date = d.date ?? ctx.today

  const q = isGoal ? { tokens, count: null } : takeQuantity(tokens)
  tokens = q.tokens

  const amount = findAmount(tokens, aliasToCode)
  if (!amount || amount.value <= 0) return { type: 'error', reason: 'no_amount' }
  if (date > ctx.today) return { type: 'error', reason: 'future' }

  // remove amount tokens (plus a lone "+" right before them)
  let start = amount.index
  if (start > 0 && tokens[start - 1] === '+') {
    amount.plus = true
    start -= 1
  }
  const rest = [...tokens.slice(0, start), ...tokens.slice(amount.index + amount.length)]
  const amountAt = start // position in `rest` where the amount used to be

  let currency = amount.currency
  let guess = amount.guess
  if (!currency) {
    const found = currencyWord(rest, amountAt, aliasToCode)
    if (found) {
      currency = found.code
      guess = found.guessed ? { word: stripPunct(rest[found.index]), code: found.code } : null
      rest.splice(found.index, 1)
    }
  }
  currency = currency ?? ctx.defaultCurrency

  if (isGoal) {
    return {
      type: 'goal',
      goalName: rest.join(' '),
      amount: amount.negative ? -amount.value : amount.value,
      currency,
      date,
    }
  }

  // account (multi mode only): exact name/alias, else the fuzzy key
  let accountId: string | null = null
  let accountAmbiguous = false
  let words = rest
  if (ctx.accountsMode === 'multi') {
    const found = extractAccount(rest, ctx.accounts) ?? fuzzyAccount(rest, ctx, aliasToCode)
    if (found && 'ambiguous' in found) accountAmbiguous = true
    else if (found) {
      accountId = found.id
      words = found.rest
    }
  }

  // category: learned keywords -> built-in dictionary
  const plus = amount.plus
  const incomeOnly = plus ? 'income' : undefined
  let match = matchCategory(words, ctx.categories, incomeOnly) ?? matchDictionary(words, ctx.categories, incomeOnly)
  let kind: 'expense' | 'income' = 'expense'
  if (match) {
    kind = match.kind
  } else if (plus) {
    kind = 'income'
    match = firstActive(ctx.categories, 'income')
  }

  const count = q.count
  const total = count ? Math.round(count * amount.value * 100) / 100 : amount.value
  let note = words.join(' ')
  if (count) {
    const head = note ? note[0].toUpperCase() + note.slice(1) + ' ' : ''
    note = `${head}×${count} по ${money(amount.value, currency)}`
  }

  return {
    type: 'tx',
    kind,
    amount: total,
    currency,
    categoryId: match ? match.id : null,
    accountId,
    date,
    note,
    firstWord: words.length ? words[0] : null,
    dateGiven: d.date !== null,
    currencyGuess: guess,
    accountAmbiguous,
    quantity: count ? { count, price: amount.value } : null,
  }
}

/** A stand-alone currency word: exact aliases right after, then anywhere; fuzzy only right next to the amount. */
function currencyWord(
  rest: string[],
  amountAt: number,
  aliases: Map<string, string>,
): { index: number; code: string; guessed: boolean } | null {
  const adjacent = [amountAt, amountAt - 1].filter((i) => i >= 0 && i < rest.length)
  const order: number[] = []
  for (let i = amountAt; i < rest.length; i++) order.push(i)
  for (let i = 0; i < amountAt; i++) order.push(i)
  for (const i of order) {
    const w = stripPunct(rest[i]) // "eur." / "грн," are still the currency
    if (ADJACENT_ONLY.has(w) && !adjacent.includes(i)) continue
    const code = aliases.get(w)
    if (code) return { index: i, code, guessed: false }
  }
  for (const i of adjacent) {
    const f = fuzzyCurrency(rest[i], aliases)
    if (f) return { index: i, ...f }
  }
  return null
}

/**
 * "1 200", "1 200 000 грн", "12 345,50": a 1-3 digit head followed by groups of exactly 3 digits.
 * Only the last group may carry decimals, a glued currency or trailing punctuation.
 */
function thousands(tokens: string[], i: number, aliasToCode: Map<string, string>): Amount | null {
  const head = THOUSAND_HEAD_RE.exec(tokens[i])
  if (!head) return null
  const prefixCode = head[2] ? aliasToCode.get(head[2]) : undefined
  if (head[2] && !prefixCode) return null

  let number = head[3]
  let suffix: { code: string; guessed: boolean } | null = null
  let suffixWord = ''
  let j = i + 1
  while (j < tokens.length) {
    const raw = tokens[j]
    const clean = stripPunct(raw)
    const tail = THOUSAND_TAIL_RE.exec(clean)
    if (!tail) break
    const code = tail[2] ? fuzzyCurrency(tail[2], aliasToCode) : null
    if (tail[2] && !code) break
    number += tail[1]
    j++
    // decimals, a currency or punctuation close the number
    if (code || /[.,]/.test(tail[1]) || clean !== raw) {
      suffix = code
      suffixWord = tail[2] ?? ''
      break
    }
  }
  if (j === i + 1) return null
  return {
    index: i,
    length: j - i,
    value: Number(number.replace(',', '.')),
    negative: head[1] === '-',
    plus: head[1] === '+',
    currency: prefixCode ?? suffix?.code ?? null,
    guess: !prefixCode && suffix?.guessed ? { word: suffixWord, code: suffix.code } : null,
  }
}

/** The amount at token i (thousands merged, glued currency read), or null. */
export function amountAt(tokens: string[], i: number, aliasToCode: Map<string, string>): Amount | null {
  const merged = thousands(tokens, i, aliasToCode)
  if (merged) return merged

  // trailing punctuation is not part of the number or the currency: "80.", "15eur!", "12,50,"
  const m = AMOUNT_RE.exec(stripPunct(tokens[i]))
  if (!m) return null
  const prefixCode = m[2] ? aliasToCode.get(m[2]) : undefined
  if (m[2] && !prefixCode) return null
  const suffix = m[4] ? fuzzyCurrency(m[4], aliasToCode) : null
  if (m[4] && !suffix) return null
  return {
    index: i,
    length: 1,
    value: Number(m[3].replace(',', '.')),
    negative: m[1] === '-',
    plus: m[1] === '+',
    currency: prefixCode ?? suffix?.code ?? null,
    guess: !prefixCode && suffix?.guessed ? { word: m[4], code: suffix.code } : null,
  }
}

function findAmount(tokens: string[], aliasToCode: Map<string, string>): Amount | null {
  for (let i = 0; i < tokens.length; i++) {
    const a = amountAt(tokens, i, aliasToCode)
    if (a) return a
  }
  return null
}

function liveAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.deleted && !a.archived)
}

export function extractAccount(words: string[], accounts: Account[]): { id: string; rest: string[] } | null {
  const phrases: { id: string; parts: string[] }[] = []
  for (const a of liveAccounts(accounts)) {
    for (const label of [a.name, ...a.aliases]) {
      const parts = label.toLowerCase().trim().split(/\s+/).filter(Boolean)
      if (parts.length) phrases.push({ id: a.id, parts })
    }
  }
  phrases.sort((x, y) => y.parts.length - x.parts.length)

  for (let i = 0; i < words.length; i++) {
    for (const p of phrases) {
      if (i + p.parts.length > words.length) continue
      if (p.parts.every((part, k) => stripPunct(words[i + k]) === part)) {
        return { id: p.id, rest: [...words.slice(0, i), ...words.slice(i + p.parts.length)] }
      }
    }
  }
  return null
}

/**
 * Spec §5 «Умное узнавание счёта»: a word (>= 4 letters), two neighbouring words glued, or a word typed
 * in the other layout whose key matches one account's name/alias key. Amounts, currencies and
 * category words are never accounts. A word that fits two accounts picks none.
 */
export function fuzzyAccount(
  words: string[],
  ctx: Pick<ParseContext, 'accounts' | 'categories'>,
  aliases: Map<string, string>,
): { id: string; rest: string[] } | { ambiguous: true } | null {
  const accounts = liveAccounts(ctx.accounts)
  if (accounts.length === 0) return null
  const keys = accounts.map((a) => ({ id: a.id, keys: [a.name, ...a.aliases].map(accountKey).filter(Boolean) }))
  const skip = (w: string) =>
    !w || /\d/.test(w) || aliases.has(w) || (w.match(/\p{L}/gu) ?? []).length < 2 ||
    matchCategory([w], ctx.categories) !== null || matchDictionary([w], ctx.categories) !== null

  const tries: { from: number; to: number; text: string; minLetters: number }[] = []
  for (let i = 0; i < words.length; i++) {
    const w = stripPunct(words[i])
    if (!skip(w)) {
      tries.push({ from: i, to: i + 1, text: w, minLetters: 4 })
      const swapped = layoutSwap(w)
      if (swapped && swapped !== w) tries.push({ from: i, to: i + 1, text: swapped, minLetters: 4 })
    }
    const next = stripPunct(words[i + 1] ?? '')
    const loose = (x: string) => !x || /\d/.test(x) || aliases.has(x)
    if (next && !loose(w) && !loose(next)) tries.push({ from: i, to: i + 2, text: w + next, minLetters: 4 })
  }
  // whole words first, then glued pairs (in order of appearance)
  tries.sort((a, b) => (a.to - a.from) - (b.to - b.from) || a.from - b.from)
  for (const t of tries) {
    if ((t.text.match(/\p{L}/gu) ?? []).length < t.minLetters) continue
    const k = accountKey(t.text)
    const hits = keys.filter((a) => a.keys.some((ak) => keyMatches(k, ak)))
    if (hits.length === 1) return { id: hits[0].id, rest: [...words.slice(0, t.from), ...words.slice(t.to)] }
    if (hits.length > 1) return { ambiguous: true }
  }
  return null
}

function activeCategories(categories: Category[], kind?: 'expense' | 'income'): Category[] {
  return categories
    .filter((c) => !c.deleted && !c.deleted_at && !c.archived && (!kind || c.kind === kind))
    .sort((a, b) => a.sort - b.sort)
}

function firstActive(categories: Category[], kind: 'expense' | 'income'): Category | null {
  return activeCategories(categories, kind)[0] ?? null
}

/**
 * Per word, in order: rule A (word starts with a keyword) or rule B (a keyword starts with the
 * word, word length >= 3). First word that matches any category wins. Within one word an exact
 * keyword beats rule A, which beats rule B (so "авто" is Авто, not "автобус" -> Транспорт);
 * remaining ties go to the lower category `sort`.
 */
export function matchCategory(
  words: string[],
  categories: Category[],
  kind?: 'expense' | 'income',
): Category | null {
  const cats = activeCategories(categories, kind)
  for (const raw of words) {
    const word = stripPunct(raw)
    if (!word) continue
    let best: Category | null = null
    let bestRank = 0
    for (const cat of cats) {
      for (const kwRaw of cat.keywords) {
        const kw = kwRaw.toLowerCase().trim()
        if (!kw) continue
        let rank = 0
        if (word === kw) rank = 3
        else if (word.startsWith(kw)) rank = 2
        else if (word.length >= 3 && kw.startsWith(word)) rank = 1
        if (rank > bestRank) {
          best = cat
          bestRank = rank
        }
      }
    }
    if (best) return best
  }
  return null
}

/**
 * The built-in dictionary (dictionary.ts) for the standard categories that still exist: per word,
 * exact match or (dictionary words of 4+ letters) the word starts with it; else the same in Latin
 * transliteration (`silpo` = `сильпо`).
 */
export function matchDictionary(
  words: string[],
  categories: Category[],
  kind?: 'expense' | 'income',
): Category | null {
  const cats = activeCategories(categories, kind).filter((c) => DICTIONARY[c.name])
  for (const raw of words) {
    const word = stripPunct(raw)
    if (!word) continue
    for (const exact of [true, false]) {
      for (const cat of cats) {
        for (const entry of DICTIONARY[cat.name]) {
          if (exact ? word === entry : [...entry].length >= 4 && word.startsWith(entry)) return cat
        }
      }
    }
    const key = accountKey(word)
    if (key.length >= 4) {
      for (const cat of cats) if (DICTIONARY[cat.name].some((e) => accountKey(e) === key)) return cat
    }
  }
  return null
}
