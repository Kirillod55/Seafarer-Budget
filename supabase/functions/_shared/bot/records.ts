// Records written from text: one or several expenses/incomes, goal moves, their replies and buttons
// (Категория · счёт · Отменить), the question about a word without an amount. No npm imports.
import { limitCrossing, limitStatus, reservedUsd } from '../calc.ts'
import { monthOf } from '../dates.ts'
import { money } from '../format.ts'
import { round2, usdRate } from '../fx.ts'
import { parseRecords } from '../multi.ts'
import type { ParseContext, TxParsed } from '../parser.ts'
import type { Category, GoalMove, Transaction } from '../types.ts'
import {
  activeAccounts, activeCategories, amountText, budgetOf, categoryOf, defaultAccount, describeTx, isMulti, load,
  partnerName, records, send, short, toOwner, todayLine, usd,
} from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import type { BotReply } from './types.ts'

export const OTHER_EXPENSE = 'прочее'
const CURRENCY_NAME: Record<string, string> = { UAH: 'гривны', USD: 'доллары', EUR: 'евро', MDL: 'леи' }

export function parseCtx(ctx: Ctx, snap: Pick<Snapshot, 'categories' | 'accounts'>): ParseContext {
  return {
    currencies: ctx.settings.currencies, defaultCurrency: ctx.settings.default_currency, categories: snap.categories,
    accounts: snap.accounts, accountsMode: ctx.settings.accounts_mode, today: ctx.today,
  }
}

/** Build (not save) the transaction of a parsed record: account, «Прочее», USD rate, author. */
export function buildTx(ctx: Ctx, snap: Snapshot, p: TxParsed, over: Partial<Transaction> = {}): Transaction | null {
  const account = (p.accountId ? snap.accounts.find((a) => a.id === p.accountId) : undefined) ?? defaultAccount(snap.accounts)
  if (!account) return null
  let categoryId = p.categoryId
  if (categoryId === null && p.kind === 'expense') {
    categoryId = activeCategories(snap.categories, 'expense').find((c) => c.name.toLowerCase() === OTHER_EXPENSE)?.id ?? null
  }
  const r = usdRate(snap.rates, p.currency, p.date)
  return {
    id: ctx.uuid(), deleted: false, kind: p.kind, amount: p.amount, currency: p.currency,
    rate_usd: r ? r.rate : 0, amount_usd: r ? round2(p.amount * r.rate) : 0, rate_pending: !r || !r.exact,
    account_id: account.id, to_account_id: null, to_amount: null, to_currency: null, category_id: categoryId,
    date: p.date, note: p.note, source: 'bot', created_at: ctx.now.toISOString(), author: ctx.author, archived: false,
    deleted_at: null, deleted_batch: null, ...over,
  }
}

/** «⚠️ Кафе за месяц: $80.94 из $100» when the expense's category has a limit. */
function limitLine(snap: Snapshot, tx: Transaction, before: Transaction[]): string {
  if (tx.kind !== 'expense' || !tx.category_id) return ''
  const limit = snap.limits.find((l) => l.category_id === tx.category_id)
  if (!limit) return ''
  const month = monthOf(tx.date)
  const b = limitStatus(limit, before, month)
  const a = limitStatus(limit, [...before, tx], month)
  const crossing = limitCrossing(b.share, a.share)
  const name = snap.categories.find((c) => c.id === tx.category_id)?.name ?? ''
  const emoji = crossing === 'over' ? '🔴 ' : crossing === 'warn' ? '⚠️ ' : ''
  return `${emoji}${name} за месяц: ${usd(a.spentUsd)} из ${usd(limit.monthly_usd)}`
}

/** Buttons under a single record: Категория · other accounts (multi mode) · Отменить. */
export function recordKeyboard(ctx: Ctx, snap: Snapshot, tx: Transaction): Keyboard {
  const kb: Keyboard = []
  if (tx.kind === 'expense' || tx.kind === 'income') kb.push([{ text: '🏷 Категория', callback_data: `c:${tx.id}` }])
  if (isMulti(ctx.settings) && (tx.kind === 'expense' || tx.kind === 'income')) {
    const others = activeAccounts(snap.accounts).filter((a) => a.id !== tx.account_id)
    for (let i = 0; i < others.length; i += 3) {
      kb.push(others.slice(i, i + 3).map((a) => ({ text: a.name, callback_data: `a:${tx.id}:${short(a.id)}` })))
    }
  }
  kb.push([{ text: 'Отменить', callback_data: `u:${tx.id}` }])
  return kb
}

/** Category picker for a record: same kind, current one left out. */
export function categoryKeyboard(snap: Snapshot, tx: Transaction): Keyboard {
  const kind = tx.kind === 'income' ? 'income' : 'expense'
  const cats = activeCategories(snap.categories, kind).filter((c) => c.id !== tx.category_id)
  const kb: Keyboard = []
  for (let i = 0; i < cats.length; i += 2) {
    kb.push(cats.slice(i, i + 2).map((c) => ({ text: `${c.icon} ${c.name}`, callback_data: `c:${tx.id}:${short(c.id)}` })))
  }
  kb.push([{ text: 'Отменить', callback_data: `u:${tx.id}` }])
  return kb
}

/** The text of a single saved record (also used when it is edited by a button or a reply). */
export function singleText(ctx: Ctx, snap: Snapshot, tx: Transaction, extra: string[] = []): string {
  const lines = [describeTx(tx, snap, ctx), ...extra]
  const day = tx.kind === 'expense' ? todayLine(ctx, snap) : ''
  if (day) lines.push(day)
  return lines.filter(Boolean).join('\n')
}

/** Kirill's notice about Masha's record: «Маша: Кафе и рестораны · $30 · Основной · на сегодня осталось $29.67». */
function partnerNotice(ctx: Ctx, snap: Snapshot, txs: Transaction[]): BotReply[] {
  if (ctx.author !== 'partner') return []
  const name = partnerName(ctx.settings)
  const b = budgetOf(ctx, snap)
  const tail = b.state === 'no_date' || b.state === 'sea' ? '' : b.leftToday < 0
    ? ` · перерасход за сегодня ${usd(-b.leftToday)}` : ` · на сегодня осталось ${usd(b.leftToday)}`
  const lines = txs.map((t) => {
    const c = categoryOf(t, snap.categories)
    const acc = isMulti(ctx.settings) ? ` · ${snap.accounts.find((a) => a.id === t.account_id)?.name ?? ''}` : ''
    return t.kind === 'income' ? `доход ${c.name} · +${usd(t.amount_usd)}${acc}` : `${c.name} · ${usd(t.amount_usd)}${acc}`
  })
  return toOwner(ctx, `${name}: ${lines.join('; ')}${txs.some((t) => t.kind === 'expense') ? tail : ''}`)
}

/** Save one parsed record and answer with its line, buttons and «Сегодня осталось». */
export async function saveOne(ctx: Ctx, p: TxParsed, prefix: string[] = []): Promise<BotReply[]> {
  const snap = await load(ctx)
  const tx = buildTx(ctx, snap, p)
  if (!tx) return [send(ctx, 'Нет счёта — открой приложение, чтобы он создался.')]
  const limit = limitLine(snap, tx, snap.txs)
  await ctx.store.insertTx(tx)
  snap.txs.push(tx)

  const extra: string[] = []
  if (p.currencyGuess) extra.push(`«${p.currencyGuess.word}» понял как ${CURRENCY_NAME[p.currencyGuess.code] ?? p.currencyGuess.code}`)
  if (limit) extra.push(limit)
  let text = singleText(ctx, snap, tx, extra)
  let kb = recordKeyboard(ctx, snap, tx)
  const other = activeCategories(snap.categories, 'expense').find((c) => c.name.toLowerCase() === OTHER_EXPENSE)
  if (tx.kind === 'expense' && p.categoryId === null && other && tx.category_id === other.id) {
    text += '\n\nНе нашёл категорию, записал в «Прочее». Если нужно, выбери другую:'
    kb = categoryKeyboard(snap, tx)
  }
  if (p.accountAmbiguous) text += '\nНе понял, какой счёт, — записал на основной. Выбери кнопкой:'
  if (prefix.length) text = `${prefix.join('\n')}\n${text}`
  return [send(ctx, text, kb), ...partnerNotice(ctx, snap, [tx])]
}

/** Save several records at once: «Записал 3: …», one row of buttons per record, «Отменить все». */
export async function saveMany(ctx: Ctx, items: TxParsed[], prefix: string[] = [], over: Partial<Transaction> = {}): Promise<BotReply[]> {
  const snap = await load(ctx)
  const txs: Transaction[] = []
  for (const p of items) {
    const tx = buildTx(ctx, snap, p, over)
    if (!tx) return [send(ctx, 'Нет счёта — открой приложение, чтобы он создался.')]
    txs.push(tx)
  }
  for (const tx of txs) await ctx.store.insertTx(tx)
  snap.txs.push(...txs)
  return [send(ctx, manyText(ctx, snap, txs, prefix), manyKeyboard(snap, txs)), ...partnerNotice(ctx, snap, txs)]
}

export function manyText(ctx: Ctx, snap: Snapshot, txs: Transaction[], prefix: string[] = []): string {
  const lines = [...prefix, `Записал ${txs.length}:`]
  txs.forEach((t, i) => lines.push(`${i + 1}) ${describeTx(t, snap, ctx)}`))
  const spent = round2(txs.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount_usd, 0))
  if (spent > 0) lines.push(`Итого ${usd(spent)}`)
  const day = todayLine(ctx, snap)
  if (day && txs.some((t) => t.kind === 'expense')) lines.push(day)
  return lines.join('\n')
}

export function manyKeyboard(snap: Snapshot, txs: Transaction[]): Keyboard {
  const kb: Keyboard = txs.map((t, i) => [
    { text: `✏️ ${i + 1} · ${categoryOf(t, snap.categories).name}`, callback_data: `c:${t.id}` },
    { text: '✕', callback_data: `u:${t.id}` },
  ])
  kb.push([{ text: 'Отменить все', callback_data: 'uall' }])
  return kb
}

/** «Не понял, к какой трате «чек»:» — asked as a reply to the source message, nothing is saved yet. */
export function askOrphan(ctx: Ctx, items: TxParsed[], orphans: string[], choices: number[], snapCats: Category[], source: string): BotReply {
  const word = orphans[choices.length]
  const base = choices.join('.')
  const pre = base ? `${base}.` : ''
  const kb: Keyboard = items.map((p, i) => {
    const c = p.categoryId ? snapCats.find((x) => x.id === p.categoryId) : undefined
    return [{ text: `${c?.icon ?? '📦'} ${p.note || c?.name || 'запись'} · ${money(p.amount, p.currency)}`, callback_data: `ow:${pre}${i + 1}` }]
  })
  kb.push([{ text: 'Без этого слова', callback_data: `ow:${pre}0` }, { text: 'Отмена', callback_data: 'ow:x' }])
  return send(ctx, `📝 «${source}»\nНе понял, к какой трате «${word}»:`, kb, { replyTo: ctx.messageId })
}

/** Records from text: one (as 1.0) or several; the orphan question; the line without an amount. */
export async function writeRecords(ctx: Ctx, text: string, choices: number[] = [], prefix: string[] = []): Promise<BotReply[] | null> {
  const [categories, accounts] = await Promise.all([ctx.store.categories(), ctx.store.accounts()])
  const r = parseRecords(text, parseCtx(ctx, { categories, accounts }), choices)
  switch (r.type) {
    case 'single': {
      const p = r.parsed
      if (p.type === 'tx') return saveOne(ctx, p, prefix)
      if (p.type === 'goal') return runGoal(ctx, p)
      if (p.type === 'error' && p.reason === 'future') return [send(ctx, 'Не записываю в будущее — проверь дату')]
      return null // a command or no amount: the caller decides
    }
    case 'records':
      return saveMany(ctx, r.items, prefix)
    case 'ask':
      return [askOrphan(ctx, r.items, r.orphans, choices, categories, text)]
    case 'no_amount':
      return [send(ctx, `Строка ${r.line} без суммы: «${r.text}»`)]
    case 'future':
      return [send(ctx, 'Не записываю в будущее — проверь дату')]
    case 'too_many':
      return [send(ctx, 'Слишком много записей сразу — не больше 20')]
  }
}

// ---------------------------------------------------------------------------
// goals: «цель машина 500»
// ---------------------------------------------------------------------------
export async function runGoal(ctx: Ctx, p: { goalName: string; amount: number; currency: string; date: string }): Promise<BotReply[]> {
  const snap = await load(ctx)
  const goals = snap.goals.filter((g) => !g.archived)
  const needle = p.goalName.trim().toLowerCase()
  const goal = needle
    ? (goals.find((g) => g.name.toLowerCase() === needle) ?? goals.find((g) => g.name.toLowerCase().startsWith(needle)))
    : undefined
  if (!goal) {
    const list = goals.length ? `\nТвои цели: ${goals.map((g) => g.name).join(', ')}` : '\nЦелей пока нет — создай в приложении'
    return [send(ctx, `Цель «${p.goalName}» не найдена${list}`)]
  }
  const r = usdRate(snap.rates, p.currency, p.date)
  if (!r) return [send(ctx, 'Нет курса для этой валюты')]
  const amountUsd = round2(p.amount * r.rate)
  const move: GoalMove = {
    id: ctx.uuid(), deleted: false, goal_id: goal.id, amount_usd: amountUsd, date: p.date, note: '', author: ctx.author,
    source: 'bot', created_at: ctx.now.toISOString(),
  }
  await ctx.store.insertGoalMove(move)
  const saved = round2(reservedUsd([...snap.moves, move], goal.id))
  const sign = amountUsd >= 0 ? '+' : ''
  const name = partnerName(ctx.settings)
  const notice = amountUsd >= 0 ? `${name} отложила ${usd(amountUsd)} в «${goal.name}»` : `${name} забрала ${usd(-amountUsd)} из «${goal.name}»`
  return [
    send(ctx, `🎯 ${goal.name}: ${sign}${usd(amountUsd)}\nНакоплено ${usd(saved)} из ${usd(goal.target_usd)}`, [
      [{ text: 'Отменить', callback_data: `ug:${move.id}` }],
    ]),
    ...toOwner(ctx, notice),
  ]
}

export { amountText, records }
