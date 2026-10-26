// CSV export of the transactions and parsing / planning of «Загрузить из CSV».
// Pure code, no browser or npm imports: the app, the bot and the Sunday backup share it.
// The export is a full backup (spec §10): every kind of record goes out, and importing the file into a book
// with the same accounts reproduces the balances per account and currency.
import { alive } from './alive.ts'
import type { Account, Author, Category, Transaction, TxKind } from './types.ts'

const BOM = '﻿' // makes Excel read the file as UTF-8
const SEPARATOR = ';'
const EOL = '\r\n'
const HEADER = [
  'Дата',
  'Тип',
  'Сумма',
  'Валюта',
  'Сумма USD',
  'Категория',
  'Счёт',
  'Заметка',
  'Кто',
  'Счёт куда',
  'Сумма куда',
  'Валюта куда',
]
const OWNER_LABEL = 'Я'
const DEFAULT_PARTNER_LABEL = 'Она'
const DEFAULT_CURRENCY = 'UAH'

const KIND_LABEL: Record<TxKind, string> = {
  expense: 'Расход',
  income: 'Доход',
  transfer: 'Перевод',
  exchange: 'Обмен',
  adjustment: 'Корректировка',
}

/** «Кто» of the second person: their name, or «Она» when none is set. */
const partnerLabelOf = (partnerName: string | null) => partnerName?.trim() || DEFAULT_PARTNER_LABEL

/** A cell: quoted CSV-style when it holds the separator, a quote or a line break. */
function cell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** 12.5 → «12,5», -0.01 → «-0,01» */
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
  const partnerLabel = partnerLabelOf(partnerName)

  const rows = txs.filter(alive).map((t) => {
    // the second leg: transfer = same money onto «Счёт куда»; exchange = «Сумма куда» in «Валюта куда»
    let to: [string, string, string] = ['', '', '']
    if (t.kind === 'transfer' && t.to_account_id) {
      to = [accountName.get(t.to_account_id) ?? '', number(t.to_amount ?? t.amount), t.to_currency ?? t.currency]
    } else if (t.kind === 'exchange' && t.to_amount !== null && t.to_currency !== null) {
      to = [t.to_account_id ? (accountName.get(t.to_account_id) ?? '') : '', number(t.to_amount), t.to_currency]
    }
    return [
      t.date,
      KIND_LABEL[t.kind] ?? t.kind,
      number(t.amount),
      t.currency,
      number(t.amount_usd),
      (t.category_id && categoryName.get(t.category_id)) || '',
      accountName.get(t.account_id) ?? '',
      t.note,
      t.author === 'partner' ? partnerLabel : OWNER_LABEL,
      ...to,
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
  kind: TxKind
  /** positive; signed for a correction (adjustment) */
  amount: number
  currency: string
  /** expense / income only ('' for the other kinds) */
  category: string
  /** «Счёт» as written ('' = the default account) */
  account: string
  note: string
  author: Author
  /** «Счёт куда»: the receiving account of a transfer (required) or an exchange ('' = the same account) */
  toAccount: string
  /** exchange only: what was received */
  toAmount: number | null
  toCurrency: string | null
}

export interface ImportError {
  line: number
  reason: string
}

// Maps, not object literals: a cell «constructor» or «__proto__» must not find Object.prototype's members
const KIND_BY_LABEL = new Map<string, TxKind>([
  ['', 'expense'],
  ['расход', 'expense'],
  ['доход', 'income'],
  ['корректировка', 'adjustment'],
  ['перевод', 'transfer'],
  ['обмен', 'exchange'],
])

/** A 1.0 file has no second leg of transfers and exchanges («Счёт куда / Сумма куда» came in 1.1). */
const OLD_FILE_TRANSFER = 'В старом файле нет второй половины перевода — сверь баланс через «Сверка»'
const OLD_FILE_EXCHANGE = 'В старом файле нет второй половины обмена — сверь баланс через «Сверка»'

/** Header names and labels are compared trimmed, lower-case and with «ё» read as «е» («Счет» = «Счёт»). */
const norm = (s: string) => s.trim().toLowerCase().replaceAll('ё', 'е')

/** Category names are compared trimmed and case-insensitively. */
const categoryKey = (name: string) => name.trim().toLowerCase()

/**
 * Splits CSV text into records of cells, honouring quotes: a quote at the start of a cell opens a quoted
 * cell (which may hold the separator and line breaks); anywhere else it is an ordinary character.
 */
function splitRecords(text: string, sep: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let value = ''
  let inQuotes = false
  let cellStart = true // nothing of the current cell read yet
  let line = 1
  let startLine = 1
  let touched = false // the record holds anything but a bare line break

  const endRecord = () => {
    cells.push(value)
    if (touched) records.push({ line: startLine, cells })
    cells = []
    value = ''
    touched = false
    cellStart = true
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
    if (ch === '"' && cellStart) {
      inQuotes = true
      cellStart = false
      touched = true
    } else if (ch === sep) {
      cells.push(value)
      value = ''
      cellStart = true
      touched = true
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      startLine = line
    } else {
      value += ch
      cellStart = false
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

/**
 * «1 200,50», «1200.5», «12» → number; with `signed`, a leading «-», «−» or «+» is allowed (corrections).
 * null when it is not a plain number (positive unless signed).
 */
function parseAmount(raw: string, signed = false): number | null {
  let s = raw.replace(/[\s  ]/g, '')
  let sign = 1
  if (signed && /^[-−+]/.test(s)) {
    if (s[0] !== '+') sign = -1
    s = s.slice(1)
  }
  if (s.includes(',') && s.includes('.')) {
    // the separator that comes last is the decimal one: «1.200,50» / «1,200.50»
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    s = s.replaceAll(decimal === ',' ? '.' : ',', '')
  }
  s = s.replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  if (signed) return n === 0 ? 0 : sign * n
  return n > 0 ? n : null
}

/** Signs and words people write instead of the code (compared lower-case, without a trailing dot). */
const CURRENCY_WORDS = new Map<string, string>([
  ['₴', 'UAH'],
  ['грн', 'UAH'],
  ['гривна', 'UAH'],
  ['$', 'USD'],
  ['дол', 'USD'],
  ['€', 'EUR'],
  ['евро', 'EUR'],
  ['лей', 'MDL'],
  ['l', 'MDL'],
])

/** A currency cell → a 3-letter code; '' → null (the caller decides), anything unknown → undefined. */
function parseCurrency(raw: string): string | null | undefined {
  const s = raw.trim()
  if (s === '') return null
  const word = CURRENCY_WORDS.get(s.toLowerCase().replace(/\.$/, ''))
  if (word) return word
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : undefined
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
    const key = norm(name)
    if (!index.has(key)) index.set(key, i)
  })
  for (const required of ['Дата', 'Сумма']) {
    if (!index.has(norm(required))) return { rows, errors: [{ line: header.line, reason: `Нет колонки «${required}»` }] }
  }
  const get = (cells: string[], column: string) => {
    const i = index.get(norm(column))
    return i === undefined ? '' : (cells[i] ?? '').trim()
  }
  const partnerLabel = norm(partnerLabelOf(partnerName))
  const hasToAccount = index.has(norm('Счёт куда'))
  const hasToAmount = index.has(norm('Сумма куда'))

  for (const { line, cells } of records.slice(1)) {
    if (cells.every((c) => c.trim() === '')) continue // «;;;» left by a spreadsheet
    const fail = (reason: string) => errors.push({ line, reason })

    const kind = KIND_BY_LABEL.get(norm(get(cells, 'Тип')))
    if (kind === undefined) {
      fail('Неизвестный тип')
      continue
    }

    // a 1.0 export: the transfer's «Счёт» reads «Основной → Карта», an exchange has no received amount
    if (kind === 'transfer' && !hasToAccount) {
      fail(OLD_FILE_TRANSFER)
      continue
    }
    if (kind === 'exchange' && !hasToAmount) {
      fail(OLD_FILE_EXCHANGE)
      continue
    }

    const dateRaw = get(cells, 'Дата')
    if (dateRaw === '') {
      fail('Нет даты')
      continue
    }
    const date = parseDate(dateRaw)
    if (date === null) {
      fail('Непонятная дата')
      continue
    }

    const amountRaw = get(cells, 'Сумма')
    if (amountRaw === '') {
      fail('Нет суммы')
      continue
    }
    const amount = parseAmount(amountRaw, kind === 'adjustment')
    if (amount === null) {
      fail('Непонятная сумма')
      continue
    }

    const currency = parseCurrency(get(cells, 'Валюта'))
    if (currency === undefined) {
      fail('Непонятная валюта')
      continue
    }

    const whoRaw = norm(get(cells, 'Кто'))
    let author: Author
    if (whoRaw === '' || whoRaw === norm(OWNER_LABEL)) author = 'owner'
    else if (whoRaw === partnerLabel) author = 'partner'
    else {
      fail('Непонятно, кто это')
      continue
    }

    const row: ImportRow = {
      line,
      date,
      kind,
      amount,
      currency: currency ?? DEFAULT_CURRENCY,
      category: kind === 'expense' || kind === 'income' ? get(cells, 'Категория') : '',
      account: get(cells, 'Счёт'),
      note: get(cells, 'Заметка'),
      author,
      toAccount: kind === 'transfer' || kind === 'exchange' ? get(cells, 'Счёт куда') : '',
      toAmount: null,
      toCurrency: null,
    }

    if (kind === 'transfer') {
      if (row.toAccount === '') {
        fail('Нет счёта «куда»')
        continue
      }
      const toCurrency = parseCurrency(get(cells, 'Валюта куда'))
      if (toCurrency === undefined) {
        fail('Непонятная валюта')
        continue
      }
      if (toCurrency !== null && toCurrency !== row.currency) {
        fail('Перевод в другую валюту — это обмен')
        continue
      }
    }

    if (kind === 'exchange') {
      const toAmountRaw = get(cells, 'Сумма куда')
      if (toAmountRaw === '') {
        fail('Нет суммы «куда»')
        continue
      }
      const toAmount = parseAmount(toAmountRaw)
      if (toAmount === null) {
        fail('Непонятная сумма «куда»')
        continue
      }
      const toCurrency = parseCurrency(get(cells, 'Валюта куда'))
      if (toCurrency === undefined) {
        fail('Непонятная валюта')
        continue
      }
      if (toCurrency === null) {
        fail('Нет валюты «куда»')
        continue
      }
      if (toCurrency === row.currency) {
        fail('Обмен в ту же валюту')
        continue
      }
      row.toAmount = toAmount
      row.toCurrency = toCurrency
    }

    rows.push(row)
  }
  return { rows, errors }
}

/**
 * The account an imported «Счёт» goes to: the live account with exactly that name (archived ones too, so a
 * backup restores onto them), else the default account (is_default, else the first by sort among the live,
 * not archived ones). undefined only when there is no account at all.
 */
export function resolveAccount<A extends Account>(accounts: A[], name: string): A | undefined {
  const live = accounts.filter(alive)
  const wanted = name.trim()
  const exact = wanted === '' ? undefined : live.find((a) => a.name.trim() === wanted)
  if (exact) return exact
  const open = live.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort)
  return open.find((a) => a.is_default) ?? open[0]
}

const cents = (n: number) => Math.round(n * 100)

interface KeyParts {
  date: string
  kind: string
  amount: number
  currency: string
  category: string
  note: string
  author: string
  account: string
  toAccount: string
  toAmount: number | null
  toCurrency: string | null
}

/**
 * What makes two records «the same» for the duplicate check. Expenses and incomes are compared without the
 * account (a hand-made file usually has no «Счёт»); corrections, transfers and exchanges with it, since the
 * account is what they are about.
 */
function key(r: KeyParts): string {
  const base = [r.date, r.kind, cents(r.amount), r.currency, categoryKey(r.category), r.note.trim(), r.author]
  if (r.kind === 'expense' || r.kind === 'income') return base.join('\u0000')
  return [...base, r.account, r.toAccount, r.toAmount === null ? '' : cents(r.toAmount), r.toCurrency ?? ''].join('\u0000')
}

/**
 * Splits rows into new ones and ones already in the book (a multiset: each record matches one file row), and
 * lists the category and account names that do not exist yet (their rows go to «Прочее» / the default account).
 */
export function planImport(
  rows: ImportRow[],
  existing: Transaction[],
  categories: Category[],
  accounts: Account[],
): {
  fresh: ImportRow[]
  duplicates: ImportRow[]
  unknownCategories: string[]
  unknownAccounts: string[]
  /** rows that cannot be written as they are (a transfer to an unknown or the same account); not in fresh */
  errors: ImportError[]
} {
  // an existing record's category / account is resolved among all of them, so one under an archived (or
  // binned) category or account still matches
  const categoryName = new Map(categories.map((c) => [c.id, c.name.trim()]))
  const accountName = new Map(accounts.map((a) => [a.id, a.name.trim()]))
  const knownCategories = new Set(categories.filter(alive).map((c) => categoryKey(c.name)))
  const accountOf = (name: string) => resolveAccount(accounts, name)?.name.trim() ?? ''

  const seen = new Map<string, number>()
  for (const t of existing) {
    if (!alive(t)) continue
    const transfer = t.kind === 'transfer'
    const exchange = t.kind === 'exchange'
    const k = key({
      ...t,
      category: t.kind === 'expense' || t.kind === 'income' ? (t.category_id && categoryName.get(t.category_id)) || '' : '',
      account: accountName.get(t.account_id) ?? '',
      toAccount: transfer
        ? (t.to_account_id && accountName.get(t.to_account_id)) || ''
        : exchange
          ? (accountName.get(t.to_account_id ?? t.account_id) ?? '')
          : '',
      toAmount: exchange ? t.to_amount : null,
      toCurrency: exchange ? t.to_currency : null,
    })
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }

  const fresh: ImportRow[] = []
  const duplicates: ImportRow[] = []
  const unknownCategories: string[] = []
  const unknownAccounts: string[] = []
  const errors: ImportError[] = []
  const liveAccountNames = new Set(accounts.filter(alive).map((a) => a.name.trim()))
  const noteAccount = (name: string) => {
    const n = name.trim()
    if (n !== '' && !liveAccountNames.has(n) && !unknownAccounts.includes(n)) unknownAccounts.push(n)
  }

  for (const row of rows) {
    if (row.kind === 'transfer') {
      // an unknown «Счёт куда» would fall back to the default account — often the «Счёт» itself
      // and an unknown «Счёт» too: both sides of a transfer must be named accounts ('' = the default one)
      const from = row.account.trim()
      const to = row.toAccount.trim()
      const missing = [to, from].find((name) => name !== '' && !liveAccountNames.has(name))
      if (missing !== undefined) {
        errors.push({ line: row.line, reason: `Нет счёта «${missing}» — перевод пропущу` })
        continue
      }
      if (accountOf(row.account) === accountOf(to)) {
        errors.push({ line: row.line, reason: 'Перевод на тот же счёт' })
        continue
      }
    }
    const k = key({
      ...row,
      account: accountOf(row.account),
      toAccount:
        row.kind === 'transfer' ? accountOf(row.toAccount) : row.kind === 'exchange' ? accountOf(row.toAccount || row.account) : '',
    })
    const left = seen.get(k) ?? 0
    if (left > 0) {
      seen.set(k, left - 1)
      duplicates.push(row)
    } else {
      fresh.push(row)
    }
    const name = row.category.trim()
    if (name !== '' && !knownCategories.has(categoryKey(name)) && !unknownCategories.some((u) => categoryKey(u) === categoryKey(name))) {
      unknownCategories.push(name)
    }
    noteAccount(row.account)
    noteAccount(row.toAccount)
  }
  return { fresh, duplicates, unknownCategories, unknownAccounts, errors }
}
