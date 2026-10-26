// Several records in one message (spec §5 «Несколько записей одним сообщением»): every line is its own
// record set; «;» and «, » split a line; a line with more than one amount splits into «words + amount»
// pairs (or «amount + words» when it starts with an amount). Each part goes through parseMessage.
// Pure, no npm imports.
import { aliasMap, amountAt, dateAt, dateOf, extractAccount, fuzzyAccount, fuzzyCurrency, normalize, parseMessage, stripPunct } from './parser.ts'
import type { Parsed, ParseContext, TxParsed } from './parser.ts'

export const MAX_PARTS = 20

export type MultiResult =
  /** one record, or a goal/command/error: the message reads as before (parseMessage) */
  | { type: 'single'; parsed: Parsed }
  | { type: 'records'; items: TxParsed[] }
  /** words without their own amount that are not a date, account or currency: ask where they go */
  | { type: 'ask'; items: TxParsed[]; orphans: string[] }
  | { type: 'no_amount'; line: number; text: string }
  | { type: 'future' }
  | { type: 'too_many' }

const TIMES = new Set(['x', 'х', '×', '*'])
const QTY_GLUED_RE = /^(\d{1,2})[xх×*]\d/u
const isCount = (t: string) => /^\d{1,2}$/.test(t) && Number(t) >= 2 && Number(t) <= 99

interface Span { start: number; end: number; qtyWords: boolean }

/** Amount spans of one chunk: thousands merged, quantity («2 по 50», «2x50») kept whole, sign/currency attached. */
function spans(tokens: string[], ctx: ParseContext, aliases: Map<string, string>): Span[] {
  const isDate = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const d = dateAt(tokens, i, ctx.today)
    if (d) for (let k = d.from; k < d.to; k++) isDate.add(k)
  }
  const raw: Span[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (isDate.has(i)) continue
    if (QTY_GLUED_RE.test(tokens[i])) {
      raw.push({ start: i, end: i + 1, qtyWords: false })
      continue
    }
    const a = amountAt(tokens, i, aliases)
    if (a) {
      raw.push({ start: i, end: i + a.length, qtyWords: false })
      i += a.length - 1
    }
  }
  // quantity: a count 2..99 joined to the next amount by «по» or a times sign
  const merged: Span[] = []
  for (const s of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.end === prev.start + 1 && isCount(tokens[prev.start])) {
      const between = tokens.slice(prev.end, s.start)
      const times = between.length === 1 && TIMES.has(between[0])
      const po = between.length >= 1 && between[between.length - 1] === 'по' && between.every((t) => !/\d/.test(t))
      if (times || po) {
        merged[merged.length - 1] = { start: prev.start, end: s.end, qtyWords: between.length > 1 }
        continue
      }
    }
    merged.push({ ...s })
  }
  // attach a «+» / currency sign before and a currency word right after
  for (const s of merged) {
    if (s.start > 0 && (tokens[s.start - 1] === '+' || ['$', '€', '₴'].includes(tokens[s.start - 1]))) s.start--
    const next = tokens[s.end]
    if (next !== undefined && !merged.some((o) => o.start === s.end) && fuzzyCurrency(next, aliases)) s.end++
  }
  return merged
}

/** Split one chunk into parts (token lists) and the trailing words that have no amount of their own. */
function splitChunk(tokens: string[], ctx: ParseContext, aliases: Map<string, string>): { parts: string[][]; tail: string[] } {
  const sp = spans(tokens, ctx, aliases)
  if (sp.length <= 1) return { parts: [tokens], tail: [] }
  const amountFirst = sp[0].start === 0 && !sp[0].qtyWords
  const parts: string[][] = []
  if (amountFirst) {
    sp.forEach((s, k) => parts.push(tokens.slice(s.start, k + 1 < sp.length ? sp[k + 1].start : tokens.length)))
    return { parts, tail: [] }
  }
  let from = 0
  for (const s of sp) {
    parts.push(tokens.slice(from, s.end))
    from = s.end
  }
  return { parts, tail: tokens.slice(from) }
}

/** A trailing word that applies to every part: a date, an account (multi mode) or a currency. */
function sharedWord(w: string, ctx: ParseContext, aliases: Map<string, string>): boolean {
  const word = stripPunct(w)
  if (dateOf([word], ctx.today)) return true
  if (aliases.has(word)) return true
  if (ctx.accountsMode === 'multi') {
    const found = extractAccount([word], ctx.accounts) ?? fuzzyAccount([word], ctx, aliases)
    if (found && !('ambiguous' in found)) return true
  }
  return false
}

/**
 * Parse a message that may hold several records. `choices[k]` answers orphan word k:
 * 0 = drop it, n = add it to the note of record n (1-based).
 */
export function parseRecords(text: string, ctx: ParseContext, choices: number[] = []): MultiResult {
  const aliases = aliasMap(ctx.currencies)
  let lines = text.split(/\r?\n/).map((l) => normalize(l)).filter(Boolean)
  if (lines.length === 0) return { type: 'single', parsed: parseMessage(text, ctx) }

  // a date alone on the first line is for every part
  let sharedDate: string | null = null
  if (lines.length > 1) {
    const d = dateOf(lines[0].split(' '), ctx.today)
    if (d) {
      sharedDate = d
      lines = lines.slice(1)
    }
  }

  const parts: { tokens: string[]; line: number }[] = []
  const orphans: { word: string; first: number; count: number }[] = []
  lines.forEach((line, li) => {
    const chunks = line.split(/;|,\s/).map((c) => c.trim()).filter(Boolean)
    for (const chunk of chunks) {
      let tokens = chunk.split(' ')
      // a date at the start of the line («вчера кофе 50 такси 100») is for the whole line
      let lineDate: string[] = []
      const lead = dateAt(tokens, tokens[0] === 'в' || tokens[0] === 'во' ? 1 : 0, ctx.today)
      if (lead && lead.from === 0 && lead.to < tokens.length) {
        lineDate = tokens.slice(0, lead.to)
        tokens = tokens.slice(lead.to)
      }
      const { parts: ps, tail } = splitChunk(tokens, ctx, aliases)
      const shared = tail.filter((w) => sharedWord(w, ctx, aliases))
      const first = parts.length
      for (const p of ps) parts.push({ tokens: [...lineDate, ...p, ...shared], line: li + 1 })
      for (const w of tail) if (!shared.includes(w)) orphans.push({ word: stripPunct(w), first, count: ps.length })
    }
  })

  if (parts.length === 1 && orphans.length === 0 && !sharedDate) {
    return { type: 'single', parsed: parseMessage(parts[0].tokens.join(' '), ctx) }
  }
  if (parts.length > MAX_PARTS) return { type: 'too_many' }

  const items: TxParsed[] = []
  for (const p of parts) {
    const parsed = parseMessage(p.tokens.join(' '), ctx)
    if (parsed.type === 'error' && parsed.reason === 'future') return { type: 'future' }
    if (parsed.type !== 'tx') return { type: 'no_amount', line: p.line, text: p.tokens.join(' ') }
    if (sharedDate && !parsed.dateGiven) {
      if (sharedDate > ctx.today) return { type: 'future' }
      parsed.date = sharedDate
      parsed.dateGiven = true
    }
    items.push(parsed)
  }

  if (orphans.length > choices.length) return { type: 'ask', items, orphans: orphans.map((o) => o.word) }
  orphans.forEach((o, k) => {
    const n = choices[k]
    if (n >= 1 && n <= items.length) items[n - 1].note = items[n - 1].note ? `${items[n - 1].note} ${o.word}` : o.word
  })
  return { type: 'records', items }
}
