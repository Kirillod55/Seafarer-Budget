// Read-only commands and /undo: /today /week /month /left /balance /goals /limits /export, days to landing.
import { activeBalances, balances, balanceUsd, goalProgress, limitStatus, monthReport, reservedUsd, reservingGoalMoves } from '../calc.ts'
import { toCsv } from '../csv.ts'
import { addDays, daysBetween, monthOf, prevMonth } from '../dates.ts'
import { money } from '../format.ts'
import { round2 } from '../fx.ts'
import { RESTORE_MS } from '../wipe.ts'
import { restoreBatch } from './clear.ts'
import type { Transaction } from '../types.ts'
import {
  activeAccounts, budgetOf, cap, dayMonth, describeTx, isMulti, load, monthName, partnerName, records, send,
  toOwner, usd, usdWhole,
} from './ctx.ts'
import type { Ctx, Snapshot } from './ctx.ts'
import type { BotReply } from './types.ts'

const sumUsd = (txs: Transaction[]) => round2(txs.reduce((s, t) => s + t.amount_usd, 0))
const expenses = (txs: Transaction[]) => txs.filter((t) => t.kind === 'expense')

/** «(Я $25 · Маша $11.68)» when the second person spent anything. */
export function byPerson(ctx: Ctx, txs: Transaction[]): string {
  const her = expenses(txs).filter((t) => t.author === 'partner')
  if (her.length === 0) return ''
  const mine = expenses(txs).filter((t) => t.author === 'owner')
  return ` (Я ${usd(sumUsd(mine))} · ${partnerName(ctx.settings)} ${usd(sumUsd(her))})`
}

export async function today(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  const rows = expenses(snap.txs).filter((t) => t.date === ctx.today)
  if (rows.length === 0) return [send(ctx, 'Сегодня трат нет')]
  const lines = rows.map((t) => `• ${describeTx(t, snap, ctx)}`)
  return [send(ctx, `Сегодня потрачено ${usd(sumUsd(rows))}${byPerson(ctx, rows)}:\n${lines.join('\n')}`)]
}

/** Spending per day over [from, to] and the total. */
export function daysReport(ctx: Ctx, snap: Snapshot, from: string, to: string, title: string): string {
  const rows = expenses(snap.txs).filter((t) => t.date >= from && t.date <= to)
  if (rows.length === 0) return `${title}: трат нет`
  const lines: string[] = []
  for (let d = to; d >= from; d = addDays(d, -1)) {
    const day = rows.filter((t) => t.date === d)
    if (day.length) lines.push(`${dayMonth(d)} — ${usd(sumUsd(day))}`)
  }
  return `${title}: ${usd(sumUsd(rows))}${byPerson(ctx, rows)}\n${lines.join('\n')}`
}

export async function week(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  return [send(ctx, daysReport(ctx, snap, addDays(ctx.today, -6), ctx.today, 'За неделю'))]
}

/** «Итого за октябрь: $…», categories by amount, «Сентябрь: $…». */
export function monthText(ctx: Ctx, snap: Snapshot, month: string, txs = snap.txs): string {
  const rep = monthReport(txs, month)
  const name = monthName(month)
  if (rep.byCategory.length === 0) return `За ${name} трат нет`
  const lines = rep.byCategory.map((c) => {
    const cat = snap.categories.find((x) => x.id === c.categoryId)
    const label = cat ? `${cat.icon} ${cat.name}` : '❔ Без категории'
    return `${label} · ${usd(c.usd)} (${Math.round(c.share * 100)}%)`
  })
  const prev = rep.prevTotalUsd > 0 ? `\n${cap(monthName(prevMonth(month)))}: ${usd(rep.prevTotalUsd)}` : ''
  const inMonth = txs.filter((t) => monthOf(t.date) === month)
  return `Итого за ${name}: ${usd(rep.totalUsd)}${byPerson(ctx, inMonth)}${prev}\n\n${lines.join('\n')}`
}

export async function month(ctx: Ctx, m = monthOf(ctx.today)): Promise<BotReply[]> {
  return [send(ctx, monthText(ctx, await load(ctx), m))]
}

/** /left by spec §5 and the states of §2. */
export async function left(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  const b = budgetOf(ctx, snap)
  const s = ctx.settings
  const balance = balanceUsd(activeBalances(snap.txs, snap.accounts), snap.rates, ctx.today)
  if (b.state === 'no_date') {
    return [send(ctx, `Баланс ${usdWhole(balance)} · потрачено сегодня ${usd(b.spentToday)}\nУкажи дату посадки: «посадка 20 декабря» — и я посчитаю, сколько можно тратить в день.`)]
  }
  if (b.state === 'sea') {
    return [send(ctx, `Баланс ${usdWhole(balance)} · потрачено сегодня ${usd(b.spentToday)}\nВернулся? Укажи новую дату посадки: «посадка 20 декабря».`)]
  }
  const landing = `посадка ${dayMonth(s.next_contract_date!)} (${b.days} дн)`
  const reserve = s.reserve_usd > 0 ? ` · запас ${usdWhole(s.reserve_usd)}` : ''
  const head = b.leftToday < 0
    ? `Сегодня перерасход ${usd(-b.leftToday)} (бюджет ${usd(b.perDay)})`
    : `Сегодня можно ещё ${usd(b.leftToday)} из ${usd(b.perDay)}`
  const lines = [`${head} · баланс ${usdWhole(balance)} · ${landing}${reserve}`]
  if (b.state === 'reserve') lines.push('⚠️ Ты тратишь запас к посадке')
  return [send(ctx, lines.join('\n'))]
}

/** Days until the landing date (nothing changes). */
export function daysToLanding(ctx: Ctx): BotReply[] {
  const d = ctx.settings.next_contract_date
  if (!d) return [send(ctx, 'Дата посадки не задана. Напиши: «посадка 20 декабря»')]
  const n = daysBetween(ctx.today, d)
  if (n < 0) return [send(ctx, `Посадка была ${dayMonth(d)}. Укажи новую: «посадка 20 декабря»`)]
  return [send(ctx, n === 0 ? `Посадка сегодня, ${dayMonth(d)}` : `До посадки ${n} дн — ${dayMonth(d)}`)]
}

/** /balance: per active account by currency (≈ $), total, set aside for goals, free. */
export async function balance(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  const lines: string[] = []
  const curLine = (bal: Record<string, number>) =>
    Object.entries(bal).filter(([, v]) => Math.abs(v) >= 0.005).map(([c, v]) => money(v, c)).join(' + ') || '0'
  if (isMulti(ctx.settings)) {
    for (const a of activeAccounts(snap.accounts)) {
      const bal = balances(snap.txs, a.id)
      lines.push(`${a.name}: ${curLine(bal)} ≈ ${usdWhole(balanceUsd(bal, snap.rates, ctx.today))}`)
    }
  } else {
    lines.push(curLine(activeBalances(snap.txs, snap.accounts)))
  }
  const total = balanceUsd(activeBalances(snap.txs, snap.accounts), snap.rates, ctx.today)
  const reserved = reservedUsd(reservingGoalMoves(snap.moves, snap.goals))
  lines.push(`Всего ≈ ${usdWhole(total)}`)
  if (reserved) lines.push(`Отложено в цели: ${usdWhole(reserved)}`)
  lines.push(`Свободно: ${usdWhole(round2(total - reserved))}`)
  return [send(ctx, `💰 Сколько денег\n${lines.join('\n')}`)]
}

export async function goals(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  const list = snap.goals.filter((g) => !g.archived)
  if (list.length === 0) return [send(ctx, 'Целей пока нет. Напиши: «новая цель отпуск 2000$ к июню»')]
  const lines = list.map((g) => {
    const p = goalProgress(g, snap.moves, ctx.today)
    const parts = [`🎯 ${g.name}: ${usdWhole(p.savedUsd)} из ${usdWhole(g.target_usd)} (${Math.round(p.share * 100)}%)`]
    if (p.etaDate) parts.push(`наберётся к ${dayMonth(p.etaDate)}${p.etaDate.slice(0, 4) !== ctx.today.slice(0, 4) ? ` ${p.etaDate.slice(0, 4)}` : ''}`)
    if (p.perMonthNeeded) parts.push(`откладывать ${usdWhole(p.perMonthNeeded)} в месяц`)
    return parts.join(' · ')
  })
  return [send(ctx, lines.join('\n'))]
}

export async function limits(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  if (snap.limits.length === 0) return [send(ctx, 'Лимитов нет. Напиши: «лимит на кафе 150$»')]
  const m = monthOf(ctx.today)
  const lines = snap.limits.map((l) => {
    const st = limitStatus(l, snap.txs, m)
    const c = snap.categories.find((x) => x.id === l.category_id)
    const word = st.level === 'over' ? '🔴 превышен' : st.level === 'warn' ? '⚠️ почти всё' : 'в норме'
    return `${c ? `${c.icon} ${c.name}` : 'Категория'}: ${usd(st.spentUsd)} из ${usd(l.monthly_usd)} · ${word}`
  })
  return [send(ctx, `Лимиты за ${monthName(m)}:\n${lines.join('\n')}`)]
}

/** CSV of all live records as a document, to whoever asked. */
export async function exportCsv(ctx: Ctx): Promise<BotReply[]> {
  const snap = await load(ctx)
  const rows = [...snap.txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return [csvDocument(ctx.chatId, `seafarer-budget-${ctx.today}.csv`, toCsv(rows, snap.categories, snap.accounts, ctx.settings.partner_name), `Выгрузка · ${records(rows.length)} · открыть в Excel`)]
}

export function csvDocument(chatId: number, filename: string, content: string, caption: string): BotReply {
  return { method: 'sendDocument', payload: { chat_id: chatId, document: { filename, content }, caption } }
}

/** /undo: the writer's newest — record, goal move or (24 h) deleted batch. */
export async function undo(ctx: Ctx): Promise<BotReply[]> {
  const [snap, bin] = await Promise.all([load(ctx), ctx.store.binnedTransactions()])
  const mine = <T extends { author: string; source: string }>(r: T) => r.author === ctx.author && r.source === 'bot'
  const tx = snap.txs.filter(mine).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const move = snap.moves.filter(mine).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const nowMs = ctx.now.getTime()
  const fresh = bin.filter((t) => t.deleted_at && nowMs - Date.parse(t.deleted_at) <= RESTORE_MS &&
    (ctx.author === 'owner' || t.author === 'partner'))
  const batchAt = fresh.reduce((m, t) => (t.deleted_at! > m ? t.deleted_at! : m), '')
  const candidates = [
    tx && { at: tx.created_at, kind: 'tx' as const },
    move && { at: move.created_at, kind: 'move' as const },
    batchAt && { at: batchAt, kind: 'bin' as const },
  ].filter(Boolean) as { at: string; kind: 'tx' | 'move' | 'bin' }[]
  const pick = candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (!pick) return [send(ctx, 'Нечего отменять')]
  const name = partnerName(ctx.settings)
  if (pick.kind === 'tx') {
    await ctx.store.updateTx(tx.id, { deleted: true })
    const line = describeTx(tx, snap, ctx)
    return [send(ctx, `Удалено: ${line}`), ...toOwner(ctx, `${name} отменила: ${line}`)]
  }
  if (pick.kind === 'move') {
    await ctx.store.update('goal_moves', move.id, { deleted: true })
    const g = snap.goals.find((x) => x.id === move.goal_id)
    const line = `цель «${g?.name ?? ''}» ${move.amount_usd >= 0 ? '+' : ''}${usd(move.amount_usd)}`
    return [send(ctx, `Отменено: ${line}`), ...toOwner(ctx, `${name} отменила: ${line}`)]
  }
  const batch = fresh.find((t) => t.deleted_at === batchAt)!.deleted_batch
  return restoreBatch(ctx, batch)
}

