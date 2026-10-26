// Group 3 of spec §5: reports by day/period/category/word/person, month comparison, search with buttons.
import { addDays, monthOf, prevMonth } from '../dates.ts'
import { matchCategory, matchDictionary, normalize, stripPunct, takeDate } from '../parser.ts'
import { round2 } from '../fx.ts'
import type { Transaction } from '../types.ts'
import { byPerson, daysReport, monthText } from './commands.ts'
import { cap, dayMonth, describeTx, load, monthName, partnerName, records, send, usd } from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import type { BotReply } from './types.ts'

const MONTH_NOM: Record<string, number> = {
  'январь': 1, 'января': 1, 'февраль': 2, 'февраля': 2, 'март': 3, 'марта': 3, 'апрель': 4, 'апреля': 4, 'май': 5, 'мая': 5,
  'июнь': 6, 'июня': 6, 'июль': 7, 'июля': 7, 'август': 8, 'августа': 8, 'сентябрь': 9, 'сентября': 9, 'октябрь': 10,
  'октября': 10, 'ноябрь': 11, 'ноября': 11, 'декабрь': 12, 'декабря': 12,
}

/** «сентябрь» -> the latest such month not after today ('YYYY-MM'). */
function namedMonth(words: string[], today: string): string | null {
  for (const w of words) {
    const n = MONTH_NOM[stripPunct(w)]
    if (!n) continue
    let y = Number(today.slice(0, 4))
    if (n > Number(today.slice(5, 7))) y--
    return `${y}-${String(n).padStart(2, '0')}`
  }
  return null
}

const sumUsd = (txs: Transaction[]) => round2(txs.reduce((s, t) => s + t.amount_usd, 0))
const exp = (txs: Transaction[]) => txs.filter((t) => t.kind === 'expense')

export const REPORT_RE = /^(сколько|траты|итог|сравни|мои траты|кто сколько|отч[её]т за|расходы)\b/

/** A report phrase, or null when the text is not one. */
export async function report(ctx: Ctx, text: string): Promise<BotReply[] | null> {
  const t = normalize(text).replace(/[?!.]+$/, '')
  if (!REPORT_RE.test(t)) return null
  const snap = await load(ctx)
  const words = t.split(' ')
  const name = partnerName(ctx.settings).toLowerCase()

  if (/^сравни/.test(t)) return [send(ctx, compare(ctx, snap, monthOf(ctx.today)))]

  // the period: a named month, «за неделю», a day (вчера / 21 октября / 21.10), else this month
  const month = namedMonth(words, ctx.today)
  const week = /недел/.test(t)
  const d = takeDate(words.filter((w) => w !== 'сколько'), ctx.today)
  const day = !month && !week ? d.date : null
  const rest = (day ? d.tokens : words).filter((w) => !['сколько', 'траты', 'итог', 'за', 'в', 'этом', 'месяце', 'месяц', 'на', 'ушло',
    'потратил', 'потратила', 'потратили', 'отчёт', 'отчет', 'расходы', 'неделю', 'неделя', 'всего', 'по', 'было', 'я', 'мы', 'с', 'прошлым', 'месяцем'].includes(stripPunct(w)) && !MONTH_NOM[stripPunct(w)])
  const inPeriod = (tx: Transaction) => day ? tx.date === day : week ? tx.date >= addDays(ctx.today, -6) && tx.date <= ctx.today : monthOf(tx.date) === (month ?? monthOf(ctx.today))
  const periodName = day ? dayMonth(day) : week ? 'неделю' : monthName(month ?? monthOf(ctx.today))

  // people
  if (/кто сколько/.test(t) || /^мои траты/.test(t) || rest.some((w) => stripPunct(w) === name)) {
    const rows = exp(snap.txs.filter(inPeriod))
    const mine = rows.filter((x) => x.author === 'owner')
    const her = rows.filter((x) => x.author === 'partner')
    if (/^мои траты/.test(t)) {
      const own = ctx.author === 'owner' ? mine : her
      return [send(ctx, `Твои траты за ${periodName}: ${usd(sumUsd(own))} · ${records(own.length)}`)]
    }
    if (rest.some((w) => stripPunct(w) === name)) return [send(ctx, `${cap(partnerName(ctx.settings))} за ${periodName}: ${usd(sumUsd(her))} · ${records(her.length)}`)]
    return [send(ctx, `За ${periodName}: Я ${usd(sumUsd(mine))} · ${partnerName(ctx.settings)} ${usd(sumUsd(her))} · всего ${usd(sumUsd(rows))}`)]
  }

  // a category or a word
  const left = rest.map(stripPunct).filter((w) => w.length >= 3)
  if (left.length) {
    const cat = matchCategory(left, snap.categories) ?? matchDictionary(left, snap.categories)
    const isName = cat && left.some((w) => cat.name.toLowerCase().startsWith(w.slice(0, 4)))
    // a category by its name («кафе») counts the category; any other word counts the notes that have it
    const rows = exp(snap.txs.filter(inPeriod)).filter((x) => isName
      ? x.category_id === cat!.id
      : left.some((w) => x.note.toLowerCase().includes(w.slice(0, Math.max(4, w.length - 2)))))
    const label = isName ? `${cat!.icon} ${cat!.name}` : `«${left.join(' ')}»`
    return [send(ctx, `${label} за ${periodName}: ${usd(sumUsd(rows))} · ${records(rows.length)}${byPerson(ctx, rows)}`)]
  }

  if (day) return [send(ctx, daysReport(ctx, snap, day, day, cap(dayMonth(day))))]
  if (week) return [send(ctx, daysReport(ctx, snap, addDays(ctx.today, -6), ctx.today, 'За неделю'))]
  return [send(ctx, monthText(ctx, snap, month ?? monthOf(ctx.today)))]
}

/** «сравни с прошлым месяцем»: totals and per category with ↑/↓ %. */
function compare(_ctx: Ctx, snap: Snapshot, month: string): string {
  const prev = prevMonth(month)
  const cur = exp(snap.txs.filter((t) => monthOf(t.date) === month))
  const old = exp(snap.txs.filter((t) => monthOf(t.date) === prev))
  const pct = (a: number, b: number) => (b > 0 ? `${a >= b ? '↑' : '↓'} ${Math.round(Math.abs(a - b) / b * 100)}%` : 'новое')
  const lines = [`${cap(monthName(month))}: ${usd(sumUsd(cur))} · ${cap(monthName(prev))}: ${usd(sumUsd(old))} · ${pct(sumUsd(cur), sumUsd(old))}`]
  const ids = [...new Set([...cur, ...old].map((t) => t.category_id))]
  const rows = ids.map((id) => {
    const a = sumUsd(cur.filter((t) => t.category_id === id))
    const b = sumUsd(old.filter((t) => t.category_id === id))
    const c = snap.categories.find((x) => x.id === id)
    return { a, line: `${c ? `${c.icon} ${c.name}` : '❔ Без категории'}: ${usd(a)} (было ${usd(b)}) ${pct(a, b)}` }
  }).sort((x, y) => y.a - x.a)
  return [...lines, '', ...rows.map((r) => r.line)].join('\n')
}

export const SEARCH_RE = /^(найди|найти|поиск|последние|\/last)\b/

/** «найди такси», «найди 420», «последние 10 записей», /last: up to 10 records of 90 days, newest first. */
export async function search(ctx: Ctx, text: string): Promise<BotReply[]> {
  const snap = await load(ctx)
  const t = normalize(text)
  const words = t.split(' ').slice(1).map(stripPunct).filter((w) => w && !['записи', 'записей', 'запись', 'трат', 'траты'].includes(w))
  const latest = /^(последние|\/last)/.test(t)
  const limit = Math.min(10, latest && /^\d+$/.test(words[0] ?? '') ? Number(words[0]) : 10)
  const from = addDays(ctx.today, -89)
  const cat = !latest && words.length ? (matchCategory(words, snap.categories) ?? matchDictionary(words, snap.categories)) : null
  const rows = snap.txs
    .filter((x) => !x.archived && x.date >= from && x.date <= ctx.today && (x.kind === 'expense' || x.kind === 'income'))
    .filter((x) => latest || words.every((w) => /^\d/.test(w)
      ? String(x.amount) === w.replace(',', '.')
      : x.note.toLowerCase().includes(w) || (cat !== null && x.category_id === cat.id)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
  if (rows.length === 0) return [send(ctx, 'Ничего не нашёл за 90 дней')]
  const lines = rows.map((x, i) => `${i + 1}) ${describeTx(x, snap, ctx)}${x.note ? ` · ${x.note}` : ''}${x.date === ctx.today ? '' : ''}`)
  const kb: Keyboard = []
  for (let i = 0; i < rows.length; i += 2) {
    kb.push(rows.slice(i, i + 2).flatMap((x, k) => [
      { text: `✏️ ${i + k + 1}`, callback_data: `se:${x.id}` },
      { text: `✕ ${i + k + 1}`, callback_data: `x:${x.id}` },
    ]))
  }
  return [send(ctx, `Нашёл ${records(rows.length)}:\n${lines.join('\n')}\nОтветь на это сообщение, чтобы исправить: «2 90», «2 вчера», «2 наличные»`, kb)]
}
