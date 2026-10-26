// Inline buttons of record replies: u (undo one), uall (undo every record of the message), ug (undo a
// goal move), c (category picker / pick), a (move to another account), ow (where the word without an amount goes).
import { binPatch, byShort, categoryOf, describeTx, idsInKeyboard, load, partnerName, restoreButton, send, toOwner, UNDO_TIMEOUT, undoExpired } from './ctx.ts'
import type { Ctx, Keyboard } from './ctx.ts'
import { categoryKeyboard, manyKeyboard, recordKeyboard, singleText, writeRecords } from './records.ts'
import type { BotReply } from './types.ts'
import type { Transaction } from '../types.ts'

// deno-lint-ignore no-explicit-any
export type Query = any

export function answer(q: Query, text?: string): BotReply {
  return { method: 'answerCallbackQuery', payload: text ? { callback_query_id: q.id, text } : { callback_query_id: q.id } }
}

export function edit(ctx: Ctx, q: Query, text: string, keyboard?: Keyboard, html = false): BotReply {
  const payload: Record<string, unknown> = {
    chat_id: ctx.chatId, message_id: q.message?.message_id, text, reply_markup: { inline_keyboard: keyboard ?? [] },
  }
  if (html) payload.parse_mode = 'HTML'
  return { method: 'editMessageText', payload }
}

/** The text a question/confirmation was about: the replied message, or the «🎤 Услышал: «…»» / «📝 «…»» line. */
export function sourceText(q: Query): string | null {
  const replied = q.message?.reply_to_message?.text
  if (typeof replied === 'string' && replied.trim()) return replied
  const own = String(q.message?.text ?? '')
  const m = /^(?:🎤 Услышал: |📝 )«([\s\S]*?)»\n/u.exec(own)
  return m ? m[1] : null
}

// Prepositions and conjunctions: «за квартиру» must not teach «за» (it would then catch «заправка»).
const STOPWORDS = new Set(['за', 'на', 'в', 'во', 'с', 'со', 'для', 'по', 'к', 'от', 'из', 'и', 'а', 'у', 'о', 'об', 'до', 'при', 'про'])

/** The note word worth learning as a keyword: the first one with >= 3 letters that is not a stopword. */
export function learnableWord(note: string): string | null {
  for (const raw of note.trim().split(/\s+/)) {
    const w = raw.replace(/^[.,!?;:()"'«»]+|[.,!?;:()"'«»]+$/gu, '').toLowerCase()
    if (STOPWORDS.has(w)) continue
    if ((w.match(/\p{L}/gu) ?? []).length >= 3) return w
  }
  return null
}

/** Teach the category the note's word; returns «Запомнил: …» or ''. */
export async function learn(ctx: Ctx, note: string, cat: { id: string; name: string; keywords: string[] }): Promise<string> {
  const word = learnableWord(note)
  if (!word || cat.keywords.some((k) => k.toLowerCase().trim() === word)) return ''
  await ctx.store.updateCategory(cat.id, { keywords: [...cat.keywords, word] })
  return `Запомнил: «${word}» → ${cat.name}`
}

const undoNotice = (ctx: Ctx, what: string) => toOwner(ctx, `${partnerName(ctx.settings)} отменила: ${what}`)
const notMine = (ctx: Ctx, t: { author: string }) => t.author !== ctx.author

export async function recordCallback(ctx: Ctx, q: Query, data: string): Promise<BotReply[] | null> {
  const [kind, id, arg] = data.split(':')

  if (kind === 'ow') {
    const source = sourceText(q)
    if (id === 'x' || !source) return [answer(q), edit(ctx, q, 'Отменил — ничего не записано')]
    const choices = id.split('.').map(Number)
    const r = await writeRecords({ ...ctx, messageId: q.message?.reply_to_message?.message_id }, source, choices)
    if (!r) return [answer(q, 'Не получилось — напиши заново')]
    // the next question replaces this one; the result is a new message
    const next = r.find((x) => String(x.payload.text ?? '').includes('Не понял, к какой трате'))
    if (next) return [answer(q), edit(ctx, q, String(next.payload.text), (next.payload.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard)]
    return [answer(q, 'Записал'), edit(ctx, q, `📝 «${source}» — записал`), ...r]
  }

  if (kind === 'uall') {
    // uall:<new category's short id or empty>:<minute>
    if (undoExpired(arg, ctx.now)) return [answer(q, UNDO_TIMEOUT)]
    const snap = await load(ctx)
    const ids = idsInKeyboard(q.message?.reply_markup)
    const mine = snap.txs.filter((t) => ids.includes(t.id))
    if (mine.some((t) => notMine(ctx, t))) return [answer(q, 'Это не твои записи')]
    const batch = ctx.uuid()
    for (const t of mine) await ctx.store.updateTx(t.id, binPatch(ctx, batch))
    let kept = ''
    let catBinned = false
    if (id) {
      // «Отменить все» after «создай категорию … и впиши туда»: the new category goes too, unless it has other records
      const cat = byShort(snap.categories, id)
      if (cat && snap.txs.some((t) => t.category_id === cat.id && !mine.includes(t))) kept = '\nКатегорию оставил — в ней есть другие записи'
      else if (cat) {
        await ctx.store.update('categories', cat.id, binPatch(ctx, batch))
        catBinned = true
      }
    }
    const kb = mine.length || catBinned ? restoreButton(batch) : []
    return [answer(q, 'Отменено'), edit(ctx, q, `Отменил ${mine.length ? mine.length : 'всё'}${kept}`, kb), ...(mine.length ? undoNotice(ctx, mine.map((t) => describeTx(t, snap, ctx)).join('; ')) : [])]
  }

  if (kind === 'ug') {
    // goal moves have no bin: the move is removed for good, but only within the hour
    if (undoExpired(arg, ctx.now)) return [answer(q, UNDO_TIMEOUT)]
    const moves = await ctx.store.goalMoves()
    const m = moves.find((x) => x.id === id && !x.deleted)
    if (!m) return [answer(q, 'Уже отменено')]
    if (notMine(ctx, m)) return [answer(q, 'Это не твоя запись')]
    await ctx.store.update('goal_moves', m.id, { deleted: true })
    return [answer(q, 'Отменено'), edit(ctx, q, 'Отменено'), ...undoNotice(ctx, `цель ${m.amount_usd >= 0 ? '+' : ''}$${m.amount_usd}`)]
  }

  if (kind !== 'u' && kind !== 'c' && kind !== 'a') return null
  if (kind === 'u' && undoExpired(arg, ctx.now)) return [answer(q, UNDO_TIMEOUT)]
  const snap = await load(ctx)
  const tx = snap.txs.find((t) => t.id === id)
  if (!tx) return [answer(q, 'Запись не найдена или уже удалена')]
  if (notMine(ctx, tx)) return [answer(q, 'Это не твоя запись')]
  const multiMessage = idsInKeyboard(q.message?.reply_markup).length > 1

  if (kind === 'u') {
    const batch = ctx.uuid()
    await ctx.store.updateTx(tx.id, binPatch(ctx, batch))
    const line = describeTx(tx, snap, ctx)
    if (!multiMessage) return [answer(q, 'Удалено'), edit(ctx, q, `Удалено: ${line}`, restoreButton(batch)), ...undoNotice(ctx, line)]
    // several records: keep the message, drop this record's buttons
    // deno-lint-ignore no-explicit-any
    const rows = ((q.message?.reply_markup as any)?.inline_keyboard ?? []) as Keyboard
    const left = rows.filter((r) => !r.some((b) => b.callback_data.includes(tx.id)))
    return [answer(q, 'Удалено'), edit(ctx, q, `${q.message?.text ?? ''}\n✕ Отменил: ${line}`, left), ...undoNotice(ctx, line)]
  }

  if (kind === 'c' && !arg) {
    // the picker: in place for one record, as its own message for a list of records
    const kb = categoryKeyboard(snap, tx)
    if (multiMessage) return [answer(q), send(ctx, `Категория для «${describeTx(tx, snap, ctx)}»:`, kb)]
    return [answer(q), edit(ctx, q, `${describeTx(tx, snap, ctx)}\nВыбери категорию:`, kb)]
  }

  if (kind === 'c') {
    const target = byShort(snap.categories, arg)
    if (!target || target.archived || (target.kind !== tx.kind)) return [answer(q, 'Категория не найдена')]
    await ctx.store.updateTx(tx.id, { category_id: target.id })
    const updated: Transaction = { ...tx, category_id: target.id }
    snap.txs = snap.txs.map((t) => (t.id === tx.id ? updated : t))
    const learned = await learn(ctx, tx.note, target)
    return [answer(q, 'Готово'), edit(ctx, q, singleText(ctx, snap, updated, [learned]), recordKeyboard(ctx, snap, updated))]
  }

  // kind === 'a': move to another account
  const acc = byShort(snap.accounts, arg)
  if (!acc || acc.archived) return [answer(q, 'Счёт не найден')]
  await ctx.store.updateTx(tx.id, { account_id: acc.id })
  const moved: Transaction = { ...tx, account_id: acc.id }
  snap.txs = snap.txs.map((t) => (t.id === tx.id ? moved : t))
  if (multiMessage) return [answer(q, `Перенёс на «${acc.name}»`)]
  return [answer(q, `Перенёс на «${acc.name}»`), edit(ctx, q, singleText(ctx, snap, moved), recordKeyboard(ctx, snap, moved))]
}

export { categoryOf, manyKeyboard }
