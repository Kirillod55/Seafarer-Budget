// Deleting with a 24 h «Вернуть»: /clear (owner only: period → kind → summary + CSV → delete) and
// «удали <описание>» (one record; Masha only her own). Rows go to the bin (`deleted_at`, `deleted_batch`);
// «Вернуть» / /undo take the batch out with base_rev = rev. Buttons live 10 minutes.
import { toCsv } from '../csv.ts'
import { addDays } from '../dates.ts'
import { money } from '../format.ts'
import { aliasMap, amountAt, matchCategory, matchDictionary, normalize, stripPunct, takeDate } from '../parser.ts'
import { RESTORE_MS, selectForWipe, wipeFrom } from '../wipe.ts'
import type { WipeScope } from '../wipe.ts'
import type { Transaction } from '../types.ts'
import { csvDocument } from './commands.ts'
import { categoryOf, dayMonth, expired, load, minuteOf, records, send, usd } from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import { answer, edit } from './callbacks.ts'
import type { Query } from './callbacks.ts'
import { NOT_HER_RECORD } from './texts.ts'
import { restorePatch } from './types.ts'
import type { BinnedRow, BotReply } from './types.ts'

type ClearKind = 'e' | 'a' // only expenses / expenses and incomes
const SCOPE_LABEL: Record<WipeScope, string> = { day: 'Сутки', week: 'Неделя', month: 'Месяц', all: 'Всё время' }
const ONLY_OWNER = 'Удалять историю может только Кирилл'
const TIMEOUT = 'Время вышло, начни заново: /clear'

/** Records the period/kind selects (bin rows excluded; only expenses and incomes). */
function selected(snap: Snapshot, scope: WipeScope, kind: ClearKind, today: string): Transaction[] {
  return selectForWipe(snap.txs, scope, kind === 'e' ? 'expense' : 'all', today).filter((t) => t.kind === 'expense' || t.kind === 'income')
}

function periodText(scope: WipeScope, today: string, rows: Transaction[]): string {
  if (scope === 'day') return 'за сегодня'
  if (scope === 'all') {
    if (rows.length === 0) return 'за всё время'
    const first = rows.reduce((m, t) => (t.date < m ? t.date : m), today)
    return `за ${dayMonth(first)} — ${dayMonth(today)}`
  }
  const from = wipeFrom(scope, today)!
  return from.slice(5, 7) === today.slice(5, 7)
    ? `за ${Number(from.slice(8, 10))}–${dayMonth(today)}`
    : `за ${dayMonth(from)} — ${dayMonth(today)}`
}

/** «/clear», «очисти историю», «удали траты за неделю», «удали всё за сегодня». */
export async function startClear(ctx: Ctx, scope?: WipeScope, kind?: ClearKind): Promise<BotReply[]> {
  if (ctx.author !== 'owner') return [send(ctx, ONLY_OWNER)]
  const m = minuteOf(ctx.now)
  if (!scope) {
    const kb: Keyboard = [
      (['day', 'week', 'month', 'all'] as WipeScope[]).map((s) => ({ text: SCOPE_LABEL[s], callback_data: `cls:${s}:${m}` })),
      [{ text: 'Отмена', callback_data: 'clc' }],
    ]
    return [send(ctx, 'За какой период удалить записи?', kb)]
  }
  if (!kind) return [kindQuestion(ctx, scope, m)]
  return summary(ctx, scope, kind)
}

function kindQuestion(ctx: Ctx, scope: WipeScope, m: number): BotReply {
  return send(ctx, 'Что удалить?', [
    [{ text: 'Только траты', callback_data: `clk:${scope}:e:${m}` }, { text: 'Траты и доходы', callback_data: `clk:${scope}:a:${m}` }],
    [{ text: 'Отмена', callback_data: 'clc' }],
  ])
}

async function summary(ctx: Ctx, scope: WipeScope, kind: ClearKind): Promise<BotReply[]> {
  const snap = await load(ctx)
  const rows = selected(snap, scope, kind, ctx.today)
  if (rows.length === 0) return [send(ctx, 'За этот период записей нет')]
  const spent = rows.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount_usd, 0)
  const income = rows.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount_usd, 0)
  const sums = [spent > 0 && `траты ${usd(spent)}`, income > 0 && `доходы ${usd(income)}`].filter(Boolean).join(', ')
  const text = `Удалю ${records(rows.length)} ${periodText(scope, ctx.today, rows)}: ${sums}. Копию прислал файлом.`
  const csv = toCsv(rows, snap.categories, snap.accounts, ctx.settings.partner_name)
  return [
    csvDocument(ctx.chatId, `seafarer-budget-удалено-${ctx.today}.csv`, csv, `Копия перед удалением · ${records(rows.length)}`),
    send(ctx, text, [
      [{ text: `Удалить ${records(rows.length)}`, callback_data: `clx:${scope}:${kind}:${minuteOf(ctx.now)}` }],
      [{ text: 'Отмена', callback_data: 'clc' }],
    ]),
  ]
}

/** Put rows in the bin as one batch; returns the batch id. */
async function bin(ctx: Ctx, rows: Transaction[]): Promise<string> {
  const batch = ctx.uuid()
  const at = ctx.now.toISOString()
  // one set-based write (chunked by the store): «всё время» must not run into the Edge timeout row by row
  await ctx.store.updateMany('transactions', rows.map((t) => t.id), { deleted_at: at, deleted_batch: batch })
  return batch
}

/** «Вернуть» / /undo: the batch comes back with base_rev = rev, while 24 h have not passed. */
export async function restoreBatch(ctx: Ctx, batch: string | null): Promise<BotReply[]> {
  const nowMs = ctx.now.getTime()
  const fresh = (r: { deleted_batch?: string | null; deleted_at?: string | null }) =>
    Boolean(batch) && r.deleted_batch === batch && Boolean(r.deleted_at) && nowMs - Date.parse(r.deleted_at!) <= RESTORE_MS
  const batchTxs = (await ctx.store.binnedTransactions()).filter(fresh)
  const rows = batchTxs.filter((t) => ctx.author === 'owner' || t.author === 'partner')
  // a category / goal / limit an «Отменить» put in the same batch comes back too (Masha: only from a batch of hers)
  const others: { table: 'categories' | 'goals' | 'limits'; row: BinnedRow }[] = []
  if (batch && (ctx.author === 'owner' || batchTxs.every((t) => t.author === 'partner'))) {
    for (const table of ['categories', 'goals', 'limits'] as const) {
      for (const row of (await ctx.store.binned(table)).filter(fresh)) others.push({ table, row })
    }
  }
  if (rows.length === 0 && others.length === 0) return [send(ctx, 'Вернуть уже нельзя — прошло больше 24 часов или всё возвращено')]
  for (const o of others) await ctx.store.update(o.table, o.row.id, restorePatch(o.row))
  for (const t of rows) await ctx.store.update('transactions', t.id, restorePatch(t))
  return [send(ctx, rows.length ? `Вернул ${records(rows.length)}` : 'Вернул как было')]
}

/** «верни удалённое»: the newest batch still restorable. */
export async function restoreLatest(ctx: Ctx): Promise<BotReply[]> {
  const nowMs = ctx.now.getTime()
  const rows = (await ctx.store.binnedTransactions()).filter((t) => t.deleted_at && nowMs - Date.parse(t.deleted_at) <= RESTORE_MS &&
    (ctx.author === 'owner' || t.author === 'partner'))
  const newest = rows.sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!))[0]
  return restoreBatch(ctx, newest?.deleted_batch ?? null)
}

// ---------------------------------------------------------------------------
// «удали кофе 80 за вчера»
// ---------------------------------------------------------------------------
const DELETE_WORDS = new Set(['удали', 'удалить', 'убери', 'сотри', 'запись', 'записи', 'трату', 'траты', 'за', 'на', 'в', 'с', 'со', 'мою', 'из'])
const LAST_WORDS = new Set(['последнюю', 'последняя', 'последний', 'последнее'])

/** Is this «удали …» a /clear of a period? Returns its scope/kind, or null for a single record. */
export function clearPhrase(text: string): { scope?: WipeScope; kind?: ClearKind } | null {
  const t = normalize(text)
  if (/^(очисти|почисти)\s+(историю|всё|все|записи)/.test(t)) return {}
  const m = /^(?:удали|сотри|очисти)\s+(вс[её]|траты|доходы|записи|историю)(?![\p{L}\d])(.*)$/u.exec(t)
  if (!m) return null
  const rest = m[2]
  const scope: WipeScope | undefined = /сегодня|сутки|день/.test(rest) ? 'day' : /недел/.test(rest) ? 'week'
    : /месяц/.test(rest) ? 'month' : /всё время|все время/.test(rest) ? 'all' : m[1] === 'историю' ? undefined : undefined
  const kind: ClearKind | undefined = m[1] === 'траты' ? 'e' : m[1] === 'историю' ? undefined : 'a'
  return { scope, kind }
}

function shortLine(t: Transaction, snap: Snapshot): string {
  const c = categoryOf(t, snap.categories)
  const d = dayMonth(t.date).replace(/(\d+ \S{3})\S*/, '$1')
  return [d, c.name, t.note, money(t.amount, t.currency)].filter(Boolean).join(' · ')
}

export async function deleteByDescription(ctx: Ctx, text: string): Promise<BotReply[]> {
  const snap = await load(ctx)
  const aliases = aliasMap(ctx.settings.currencies)
  const d = takeDate(normalize(text).split(' '), ctx.today)
  let tokens = d.tokens.filter((w) => !DELETE_WORDS.has(stripPunct(w)))
  const last = tokens.some((w) => LAST_WORDS.has(stripPunct(w)))
  tokens = tokens.filter((w) => !LAST_WORDS.has(stripPunct(w)))
  let amount: { value: number; currency: string | null } | null = null
  for (let i = 0; i < tokens.length; i++) {
    const a = amountAt(tokens, i, aliases)
    if (a) {
      amount = { value: a.value, currency: a.currency }
      tokens = [...tokens.slice(0, i), ...tokens.slice(i + a.length)]
      break
    }
  }
  tokens = tokens.filter((w) => !aliases.has(stripPunct(w)))
  const words = tokens.map(stripPunct).filter((w) => w.length >= 2)
  const cat = words.length ? (matchCategory(words, snap.categories) ?? matchDictionary(words, snap.categories)) : null

  const from = addDays(ctx.today, -29)
  let found = snap.txs.filter((t) =>
    (t.kind === 'expense' || t.kind === 'income') &&
    (d.date ? t.date === d.date : t.date >= from && t.date <= ctx.today) &&
    (!amount || (t.amount === amount.value && (!amount.currency || t.currency === amount.currency))) &&
    words.every((w) => (cat && t.category_id === cat.id && (matchCategory([w], snap.categories) ?? matchDictionary([w], snap.categories))?.id === cat.id) ||
      t.note.toLowerCase().includes(w)))
  found.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
  if (last) found = found.slice(0, 1)
  if (ctx.author !== 'owner') {
    // Masha deletes only her own records; Kirill's matches get an explanation (ruling 2026-10-26)
    const hers = found.filter((t) => t.author === ctx.author)
    if (hers.length === 0 && found.length > 0) return [send(ctx, NOT_HER_RECORD)]
    found = hers
  }

  const m = minuteOf(ctx.now)
  if (found.length === 0) return [send(ctx, 'Не нашёл такую запись. Последние записи: /last')]
  if (found.length === 1) {
    const t = found[0]
    const c = categoryOf(t, snap.categories)
    const usdPart = t.currency === 'USD' ? '' : ` (${usd(t.amount_usd)})`
    const line = [c.name, t.note, `${money(t.amount, t.currency)}${usdPart}`, dayMonth(t.date)].filter(Boolean).join(' · ')
    return [send(ctx, `Удалить? ${line}`, [[{ text: 'Удалить', callback_data: `dd:${t.id}:${m}` }, { text: 'Отмена', callback_data: 'clc' }]])]
  }
  if (found.length > 5) return [send(ctx, `Нашёл ${records(found.length)} — уточни: добавь дату или сумму`)]
  const kb: Keyboard = found.map((t) => [{ text: shortLine(t, snap), callback_data: `dd:${t.id}:${m}` }])
  kb.push([{ text: 'Отмена', callback_data: 'clc' }])
  return [send(ctx, `Нашёл ${records(found.length)}, какую удалить?`, kb)]
}

export async function clearCallback(ctx: Ctx, q: Query, data: string): Promise<BotReply[] | null> {
  const [kind, a, b, c] = data.split(':')
  if (kind === 'clc') return [answer(q), edit(ctx, q, 'Отменено — ничего не удалено')]
  if (kind === 'rs') {
    const r = await restoreBatch(ctx, a)
    return [answer(q, 'Готово'), edit(ctx, q, String(r[0].payload.text))]
  }
  if (kind === 'cls') {
    if (ctx.author !== 'owner') return [answer(q, ONLY_OWNER)]
    if (expired(b, ctx.now)) return [answer(q), edit(ctx, q, TIMEOUT)]
    const k = kindQuestion(ctx, a as WipeScope, minuteOf(ctx.now))
    return [answer(q), edit(ctx, q, String(k.payload.text), (k.payload.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard)]
  }
  if (kind === 'clk') {
    if (ctx.author !== 'owner') return [answer(q, ONLY_OWNER)]
    if (expired(c, ctx.now)) return [answer(q), edit(ctx, q, TIMEOUT)]
    return [answer(q), edit(ctx, q, 'Готовлю итог…'), ...(await summary(ctx, a as WipeScope, b as ClearKind))]
  }
  if (kind === 'clx') {
    if (ctx.author !== 'owner') return [answer(q, ONLY_OWNER)]
    if (expired(c, ctx.now)) return [answer(q), edit(ctx, q, TIMEOUT)]
    const snap = await load(ctx)
    const rows = selected(snap, a as WipeScope, b as ClearKind, ctx.today)
    if (rows.length === 0) return [answer(q), edit(ctx, q, 'За этот период записей нет')]
    const batch = await bin(ctx, rows)
    return [answer(q, 'Удалено'), edit(ctx, q, `Удалено ${records(rows.length)}. Вернуть можно 24 часа`, [[{ text: 'Вернуть', callback_data: `rs:${batch}` }]])]
  }
  if (kind === 'dd' || kind === 'x') {
    if (kind === 'dd' && expired(b, ctx.now)) return [answer(q), edit(ctx, q, 'Время вышло — напиши ещё раз')]
    const snap = await load(ctx)
    const t = snap.txs.find((x) => x.id === a)
    if (!t) return [answer(q, 'Запись уже удалена')]
    if (ctx.author !== 'owner' && t.author !== ctx.author) return [answer(q, 'Это не твоя запись')]
    const batch = await bin(ctx, [t])
    const c = categoryOf(t, snap.categories)
    const line = [c.name, t.note, money(t.amount, t.currency)].filter(Boolean).join(' · ')
    return [answer(q, 'Удалено'), edit(ctx, q, `Удалил: ${line}`, [[{ text: 'Вернуть', callback_data: `rs:${batch}` }]])]
  }
  return null
}
