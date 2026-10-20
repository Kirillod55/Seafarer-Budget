// Free-text message parser: "кофе 80", "такси 15 eur", "+3000 usd", "цель машина 500".
// Pure TypeScript, no imports from npm (also runs in Deno).
import { addDays } from './dates.ts'
import type { Account, Category } from './types.ts'

export interface ParseContext {
  currencies: string[]
  defaultCurrency: string
  categories: Category[]
  accounts: Account[]
  accountsMode: 'single' | 'multi'
  today: string
}

export type Parsed =
  | {
    type: 'tx'
    kind: 'expense' | 'income'
    amount: number
    currency: string
    categoryId: string | null
    accountId: string | null
    date: string
    note: string
    firstWord: string | null
  }
  | { type: 'goal'; goalName: string; amount: number; currency: string; date: string }
  | { type: 'command'; command: 'today' | 'month' | 'left' | 'undo' | 'help' }
  | { type: 'error'; reason: 'no_amount' }

export const CURRENCY_ALIASES: Record<string, string[]> = {
  UAH: ['грн', 'гривен', 'гривна', 'гривны', 'uah', '₴'],
  USD: ['usd', '$', 'дол', 'долл', 'доллар', 'доллара', 'долларов', 'бакс', 'бакса', 'баксов'],
  EUR: ['eur', '€', 'евро'],
  MDL: ['лей', 'леев', 'лея', 'lei', 'mdl', 'l'],
}

/** Aliases that are only valid glued to the number (`90l`), never as a separate word. */
const GLUED_ONLY = new Set(['l'])

const COMMAND_WORDS: Record<string, 'today' | 'month' | 'left' | 'undo' | 'help'> = {
  'сегодня': 'today',
  'месяц': 'month',
  'остаток': 'left',
  'отмена': 'undo',
  'помощь': 'help',
}
const COMMAND_SLASH = /^\/(today|month|left|undo|help)(?:@\w+)?$/

const GOAL_WORD = 'цель'
const YESTERDAY_WORD = 'вчера'

// [sign][prefix symbol][number][glued suffix]
const AMOUNT_RE = /^([+-])?([₴$€]|l)?(\d+(?:[.,]\d+)?)([a-zа-яё₴$€]+)?$/u
// integer part of 1-3 digits, nothing else: may be the head of "1 200"
const THOUSAND_HEAD_RE = /^([+-])?([₴$€]|l)?(\d{1,3})$/u
// exactly 3 digits, optional decimals and glued suffix: the tail of "1 200"
const THOUSAND_TAIL_RE = /^(\d{3}(?:[.,]\d+)?)([a-zа-яё₴$€]+)?$/u

interface Amount {
  index: number
  length: number // tokens consumed (2 when thousands were merged)
  value: number
  negative: boolean
  plus: boolean
  currency: string | null
}

function stripPunct(word: string): string {
  return word.replace(/^[.,!?;:()"'«»]+|[.,!?;:()"'«»]+$/gu, '')
}

export function parseMessage(text: string, ctx: ParseContext): Parsed {
  const lower = text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!lower) return { type: 'error', reason: 'no_amount' }

  // commands: a single word
  const cmd = COMMAND_WORDS[lower]
  if (cmd) return { type: 'command', command: cmd }
  const slash = COMMAND_SLASH.exec(lower)
  if (slash) return { type: 'command', command: slash[1] as 'today' | 'month' | 'left' | 'undo' | 'help' }

  // currency alias -> code (only enabled currencies)
  const aliasToCode = new Map<string, string>()
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    if (!ctx.currencies.includes(code)) continue
    for (const a of aliases) aliasToCode.set(a, code)
  }

  let tokens = lower.split(' ')

  let isGoal = false
  if (tokens[0] === GOAL_WORD) {
    isGoal = true
    tokens = tokens.slice(1)
  }

  // yesterday marker
  let date = ctx.today
  const yIdx = tokens.indexOf(YESTERDAY_WORD)
  if (yIdx >= 0) {
    date = addDays(ctx.today, -1)
    tokens.splice(yIdx, 1)
  }

  const amount = findAmount(tokens, aliasToCode)
  if (!amount || amount.value <= 0) return { type: 'error', reason: 'no_amount' }

  // remove amount tokens (plus a lone "+" right before them)
  let start = amount.index
  if (start > 0 && tokens[start - 1] === '+') {
    amount.plus = true
    start -= 1
  }
  const rest = [...tokens.slice(0, start), ...tokens.slice(amount.index + amount.length)]
  const amountAt = start // position in `rest` where the amount used to be

  // standalone currency word: first after the amount, then any before it
  let currency = amount.currency
  if (!currency) {
    const order: number[] = []
    for (let i = amountAt; i < rest.length; i++) order.push(i)
    for (let i = 0; i < amountAt; i++) order.push(i)
    for (const i of order) {
      const w = stripPunct(rest[i]) // "eur." / "грн," are still the currency
      if (GLUED_ONLY.has(w)) continue
      const code = aliasToCode.get(w)
      if (code) {
        currency = code
        rest.splice(i, 1)
        break
      }
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

  // account (multi mode only)
  let accountId: string | null = null
  let words = rest
  if (ctx.accountsMode === 'multi') {
    const found = extractAccount(rest, ctx.accounts)
    if (found) {
      accountId = found.id
      words = found.rest
    }
  }

  // category
  const plus = amount.plus
  let match = matchCategory(words, ctx.categories, plus ? 'income' : undefined)
  let kind: 'expense' | 'income' = 'expense'
  if (match) {
    kind = match.kind
  } else if (plus) {
    kind = 'income'
    match = firstActive(ctx.categories, 'income')
  }

  return {
    type: 'tx',
    kind,
    amount: amount.value,
    currency,
    categoryId: match ? match.id : null,
    accountId,
    date,
    note: words.join(' '),
    firstWord: words.length ? words[0] : null,
  }
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
  let suffixCode: string | undefined
  let j = i + 1
  while (j < tokens.length) {
    const raw = tokens[j]
    const clean = stripPunct(raw)
    const tail = THOUSAND_TAIL_RE.exec(clean)
    if (!tail) break
    const code = tail[2] ? aliasToCode.get(tail[2]) : undefined
    if (tail[2] && !code) break
    number += tail[1]
    j++
    // decimals, a currency or punctuation close the number
    if (code || /[.,]/.test(tail[1]) || clean !== raw) {
      suffixCode = code
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
    currency: prefixCode ?? suffixCode ?? null,
  }
}

function findAmount(tokens: string[], aliasToCode: Map<string, string>): Amount | null {
  for (let i = 0; i < tokens.length; i++) {
    const merged = thousands(tokens, i, aliasToCode)
    if (merged) return merged

    // trailing punctuation is not part of the number or the currency: "80.", "15eur!", "12,50,"
    const m = AMOUNT_RE.exec(stripPunct(tokens[i]))
    if (!m) continue
    const prefixCode = m[2] ? aliasToCode.get(m[2]) : undefined
    const suffixCode = m[4] ? aliasToCode.get(m[4]) : undefined
    if (m[2] && !prefixCode) continue
    if (m[4] && !suffixCode) continue
    return {
      index: i,
      length: 1,
      value: Number(m[3].replace(',', '.')),
      negative: m[1] === '-',
      plus: m[1] === '+',
      currency: prefixCode ?? suffixCode ?? null,
    }
  }
  return null
}

function extractAccount(words: string[], accounts: Account[]): { id: string; rest: string[] } | null {
  const phrases: { id: string; parts: string[] }[] = []
  for (const a of accounts) {
    if (a.deleted || a.archived) continue
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

function activeCategories(categories: Category[], kind?: 'expense' | 'income'): Category[] {
  return categories
    .filter((c) => !c.deleted && !c.archived && (!kind || c.kind === kind))
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
function matchCategory(
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
