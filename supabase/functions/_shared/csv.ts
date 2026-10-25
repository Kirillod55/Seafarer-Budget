// CSV export of the transactions and parsing / planning of «Загрузить из CSV».
// Pure code, no browser or npm imports: the app, the bot and the Sunday backup share it.
import { alive } from './alive.ts'
import type { Account, Author, Category, Transaction, TxKind } from './types.ts'

const BOM = '﻿' // makes Excel read the file as UTF-8
const SEPARATOR = ';'
const EOL = '\r\n'
const HEADER = ['Дата', 'Тип', 'Сумма', 'Валюта', 'Сумма USD', 'Категория', 'Счёт', 'Заметка', 'Кто']
const OWNER_LABEL = 'Я'
const DEFAULT_PARTNER_LABEL = 'Она'

const KIND_LABEL: Record<TxKind, string> = {
  expense: 'Расход',
  income: 'Доход',
  transfer: 'Перевод',
  exchange: 'Обмен',
  adjustment: 'Корректировка',
}

/** A cell: quoted CSV-style when it holds the separator, a quote or a line break. */
function cell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** 12.5 → «12,5» */
const number = (n: number) => String(n).replace('.', ',')

/** UTF-8 CSV text (BOM, «;» separator, decimal comma) of the live transactions, in the given order. */
export function toCsv(
  txs: Transaction[],
  categories: Category[],
  accounts: Account[],
  partnerName: string | null,
): string {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const partnerLabel = partnerName || DEFAULT_PARTNER_LABEL

  const rows = txs.filter(alive).map((t) => {
    // the second leg of a transfer / exchange has no column of its own, so it goes in front of the note
    let leg = ''
    if (t.kind === 'transfer' && t.to_account_id) {
      leg = `→ ${accountName.get(t.to_account_id) ?? ''}`
    } else if (t.kind === 'exchange' && t.to_amount !== null && t.to_currency !== null) {
      leg = `→ ${number(t.to_amount)} ${t.to_currency}`
    }
    const note = leg && t.note ? `${leg} ${t.note}` : leg || t.note
    return [
      t.date,
      KIND_LABEL[t.kind] ?? t.kind,
      number(t.amount),
      t.currency,
      number(t.amount_usd),
      (t.category_id && categoryName.get(t.category_id)) || '',
      accountName.get(t.account_id) ?? '',
      note,
      t.author === 'partner' ? partnerLabel : OWNER_LABEL,
    ]
      .map(cell)
      .join(SEPARATOR)
  })

  return BOM + [HEADER.join(SEPARATOR), ...rows].join(EOL) + EOL
}

/* ---------- import ---------- */

export interface ImportRow {
  /** 1-based line in the file; the header is line 1 */
  line: number
  date: string
  kind: 'expense' | 'income'
  amount: number
  currency: string
  category: string
  account: string
  note: string
  author: Author
}

export interface ImportError {
  line: number
  reason: string
}

const SKIPPED_KINDS = new Set(['перевод', 'обмен', 'корректировка'])

/** Splits CSV text into records of cells, honouring quotes (a quoted cell may hold the separator and line breaks). */
function splitRecords(text: string, sep: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let value = ''
  let inQuotes = false
  let line = 1
  let startLine = 1
  let touched = false // the record holds anything but a bare line break

  const endRecord = () => {
    cells.push(value)
    if (touched) records.push({ line: startLine, cells })
    cells = []
    value = ''
    touched = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n') line++
        value += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      touched = true
    } else if (ch === sep) {
      cells.push(value)
      value = ''
      touched = true
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      startLine = line
    } else {
      value += ch
      touched = true
    }
  }
  endRecord() // the last record may have no line break after it
  return records
}

/** 21.10.2026 or 2026-10-21 → 2026-10-21, or null when it is not a real calendar date. */
function parseDate(raw: string): string | null {
  let y: string, m: string, d: string
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  if (match) [, y, m, d] = match
  else if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw))) [, d, m, y] = match
  else return null
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)]
  const probe = new Date(Date.UTC(yy, mm - 1, dd))
  if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) return null
  return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** «1 200,50», «1200.5», «12» → number; null when it is not a plain positive number. */
function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s  ]/g, '')
  if (s.includes(',') && s.includes('.')) {
    // the separator that comes last is the decimal one: «1.200,50» / «1,200.50»
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    s = s.replaceAll(decimal === ',' ? '.' : ',', '')
  }
  s = s.replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return n > 0 && Number.isFinite(n) ? n : null
}

/** Reads a CSV file (this app's export or a hand-made one) into rows to import; bad rows go to `errors`. */
export function parseCsv(text: string, partnerName: string | null): { rows: ImportRow[]; errors: ImportError[] } {
  const body = text.replace(/^﻿/, '')
  const headerLine = body.split(/\r\n|\r|\n/, 1)[0] ?? ''
  const sep = headerLine.includes(';') ? ';' : ','
  const records = splitRecords(body, sep)
  const rows: ImportRow[] = []
  const errors: ImportError[] = []

  const header = records[0]
  if (!header) return { rows, errors: [{ line: 1, reason: 'Файл пустой' }] }
  const index = new Map<string, number>()
  header.cells.forEach((name, i) => {
    const key = name.trim().toLowerCase()
    if (!index.has(key)) index.set(key, i)
  })
  for (const required of ['дата', 'сумма']) {
    if (!index.has(required)) {
      const title = required[0].toUpperCase() + required.slice(1)
      return { rows, errors: [{ line: header.line, reason: `Нет колонки «${title}»` }] }
    }
  }
  const get = (cells: string[], column: string) => {
    const i = index.get(column)
    return i === undefined ? '' : (cells[i] ?? '').trim()
  }
  const partnerLabel = (partnerName || DEFAULT_PARTNER_LABEL).toLowerCase()

  for (const { line, cells } of records.slice(1)) {
    const fail = (reason: string) => errors.push({ line, reason })

    const kindRaw = get(cells, 'тип').toLowerCase()
    if (SKIPPED_KINDS.has(kindRaw)) {
      fail('Этот тип не загружается')
      continue
    }
    let kind: ImportRow['kind']
    if (kindRaw === '' || kindRaw === 'расход') kind = 'expense'
    else if (kindRaw === 'доход') kind = 'income'
    else {
      fail('Неизвестный тип')
      continue
    }

    const dateRaw = get(cells, 'дата')
    if (dateRaw === '') {
      fail('Нет даты')
      continue
    }
    const date = parseDate(dateRaw)
    if (date === null) {
      fail('Непонятная дата')
      continue
    }

    const amountRaw = get(cells, 'сумма')
    if (amountRaw === '') {
      fail('Нет суммы')
      continue
    }
    const amount = parseAmount(amountRaw)
    if (amount === null) {
      fail('Непонятная сумма')
      continue
    }

    const whoRaw = get(cells, 'кто').toLowerCase()
    let author: Author
    if (whoRaw === '' || whoRaw === OWNER_LABEL.toLowerCase()) author = 'owner'
    else if (whoRaw === partnerLabel) author = 'partner'
    else {
      fail('Непонятно, кто это')
      continue
    }

    rows.push({
      line,
      date,
      kind,
      amount,
      currency: get(cells, 'валюта').toUpperCase() || 'UAH',
      category: get(cells, 'категория'),
      account: get(cells, 'счёт'),
      note: get(cells, 'заметка'),
      author,
    })
  }
  return { rows, errors }
}

const cents = (n: number) => Math.round(n * 100)
const key = (r: { date: string; kind: string; amount: number; currency: string; category: string; note: string; author: string }) =>
  [r.date, r.kind, cents(r.amount), r.currency, r.category, r.note.trim(), r.author].join('\u0000')

/** Splits rows into new ones and ones already in the book; lists the category names that do not exist yet. */
export function planImport(
  rows: ImportRow[],
  existing: Transaction[],
  categories: Category[],
  // accounts are not matched yet: imported rows go to the default account (kept in the signature for the screen)
  _accounts: Account[],
): { fresh: ImportRow[]; duplicates: ImportRow[]; unknownCategories: string[] } {
  // an existing record's category is resolved among all categories, so a record under an archived one still matches
  const categoryName = new Map(categories.map((c) => [c.id, c.name.trim()]))
  const known = new Set<string>()
  for (const c of categories) if (alive(c)) known.add(c.name.trim())

  const seen = new Set<string>()
  for (const t of existing) {
    if (!alive(t) || (t.kind !== 'expense' && t.kind !== 'income')) continue
    const category = (t.category_id && categoryName.get(t.category_id)) || ''
    seen.add(key({ ...t, category }))
  }

  const fresh: ImportRow[] = []
  const duplicates: ImportRow[] = []
  const unknown: string[] = []
  for (const row of rows) {
    ;(seen.has(key(row)) ? duplicates : fresh).push(row)
    const name = row.category.trim()
    if (name !== '' && !known.has(name) && !unknown.includes(name)) unknown.push(name)
  }
  return { fresh, duplicates, unknownCategories: unknown }
}
