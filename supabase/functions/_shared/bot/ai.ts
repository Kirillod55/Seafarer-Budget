// «Сначала правила, потом ИИ» (spec §5): when the rules are not sure, Groq parses the text; code checks the
// answer; a sure answer is saved at once («🤖 Понял так:») and teaches the category its word, an unsure one
// waits for «Записать». Voice messages are transcribed and go through the same path.
import { askAi, voicePrompt } from '../groq.ts'
import type { AiLists, AiResult } from '../groq.ts'
import { parseRecords } from '../multi.ts'
import type { TxParsed } from '../parser.ts'
import { learn } from './callbacks.ts'
import { createCategory } from './categories.ts'
import { activeAccounts, activeCategories, describeTx, isMulti, load, send } from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import { runCommand } from './intent.ts'
import type { Command } from './intent.ts'
import { buildTx, OTHER_EXPENSE, parseCtx, saveMany, saveOne } from './records.ts'
import type { BotReply } from './types.ts'

export const AI_FAILED = 'Не понял — напиши проще, например: кофе 80'
const COMMAND_BUTTONS: Keyboard = [
  [{ text: 'Проверить связь', callback_data: 'cmd:ping' }, { text: 'Траты за сегодня', callback_data: 'cmd:today' }],
  [{ text: 'Сколько осталось', callback_data: 'cmd:left' }, { text: 'Помощь', callback_data: 'cmd:help' }],
]

export function aiLists(ctx: Ctx, snap: Pick<Snapshot, 'categories' | 'accounts'>): AiLists {
  return {
    categories: activeCategories(snap.categories).map((c) => c.name),
    accounts: isMulti(ctx.settings) ? activeAccounts(snap.accounts).map((a) => a.name) : [],
    currencies: ctx.settings.currencies,
  }
}

/** The rules parsed it, but not surely: «Прочее», an ambiguous account, a word without an amount. */
export async function rulesUnsure(ctx: Ctx, text: string): Promise<boolean> {
  const [categories, accounts] = await Promise.all([ctx.store.categories(), ctx.store.accounts()])
  const r = parseRecords(text, parseCtx(ctx, { categories, accounts }))
  const doubtful = (p: TxParsed) => (p.kind === 'expense' && p.categoryId === null) || Boolean(p.accountAmbiguous)
  if (r.type === 'ask') return true
  if (r.type === 'records') return r.items.some(doubtful)
  return r.type === 'single' && r.parsed.type === 'tx' && doubtful(r.parsed)
}

function toParsed(snap: Snapshot, res: AiResult): TxParsed[] {
  return res.records.map((r) => {
    const cat = snap.categories.find((c) => c.name === r.category && c.kind === r.kind) ?? snap.categories.find((c) => c.name === r.category)
    const acc = r.account ? snap.accounts.find((a) => a.name === r.account) : undefined
    return {
      type: 'tx', kind: cat?.kind ?? r.kind, amount: r.amount, currency: r.currency, categoryId: cat?.id ?? null, accountId: acc?.id ?? null,
      date: r.date, note: r.note, firstWord: r.note.split(' ')[0] || null, dateGiven: true,
    }
  })
}

/**
 * Ask the AI and act on its answer. null when the AI is off, failed, or found nothing to do
 * (the caller then falls back to the rules or «Не понял»).
 */
export async function aiAnswer(ctx: Ctx, text: string): Promise<BotReply[] | null> {
  if (!ctx.ai) return null
  const snap = await load(ctx)
  const res = await askAi(ctx.ai, text, aiLists(ctx, snap), ctx.today)
  if (!res) return null

  if (res.records.length === 0) {
    if (res.createCategory) {
      const kind = res.createCategory.kind === 'income' ? 'доходов ' : ''
      return createCategory(ctx, `создай категорию ${kind}«${res.createCategory.name}»`)
    }
    if (res.command !== 'none') {
      if (!res.unsure) return runCommand(ctx, res.command as Command)
      return [send(ctx, 'Что сделать?', COMMAND_BUTTONS)]
    }
    return null
  }

  const items = toParsed(snap, res)
  if (res.unsure || res.dropped > 0) {
    // the shown records wait in bot_updates.draft; «Записать» saves them as they are (ruling 2026-10-26)
    if (ctx.updateId === undefined) return null
    const draft: Draft = { at: ctx.now.toISOString(), text, items }
    await ctx.store.saveDraft(ctx.updateId, draft)
    const lines = items.map((p, i) => {
      const tx = buildTx(ctx, snap, p)
      return tx ? `${i + 1}) ${describeTx(tx, snap, ctx)}${p.note ? ` · ${p.note}` : ''}` : ''
    })
    const why = res.reason ? `\n${res.reason}` : res.dropped ? '\nЧасть не разобрал — проверь' : ''
    return [send(ctx, `📝 «${text}»\n🤖 Понял так:\n${lines.join('\n')}${why}`,
      [[{ text: 'Записать', callback_data: `ai:ok:${ctx.updateId}` }, { text: 'Отмена', callback_data: 'no' }]], { replyTo: ctx.messageId })]
  }
  return saveAi(ctx, snap, items)
}

async function saveAi(ctx: Ctx, snap: Snapshot, items: TxParsed[]): Promise<BotReply[]> {
  const replies = items.length === 1 ? await saveOne(ctx, items[0], ['🤖 Понял так:']) : await saveMany(ctx, items, ['🤖 Понял так:'])
  // learn: next time the rules know the word without the AI
  for (const p of items) {
    const cat = snap.categories.find((c) => c.id === p.categoryId)
    if (cat && cat.name.toLowerCase() !== OTHER_EXPENSE && p.note) await learn(ctx, p.note, cat)
  }
  return replies
}

/** An unsure AI answer kept for «Записать»: the validated records exactly as shown. */
interface Draft {
  at: string
  text: string
  items: TxParsed[]
}

export const DRAFT_EXPIRED = 'Черновик устарел — напиши ещё раз'
const DRAFT_MS = 24 * 60 * 60 * 1000

function isDraft(d: unknown): d is Draft {
  // deno-lint-ignore no-explicit-any
  const x = d as any
  return Boolean(x) && typeof x.at === 'string' && typeof x.text === 'string' && Array.isArray(x.items) && x.items.length > 0 &&
    // deno-lint-ignore no-explicit-any
    x.items.every((p: any) => p?.type === 'tx' && typeof p.amount === 'number' && p.amount > 0 && typeof p.currency === 'string' &&
      typeof p.date === 'string' && (p.kind === 'expense' || p.kind === 'income'))
}

/**
 * «Записать» under an unsure AI answer: saves the stored draft once, never asks the AI again.
 * 'used' when it was already saved; null when there is no draft or it is older than 24 h.
 */
export async function confirmDraft(ctx: Ctx, updateId: number): Promise<{ text: string; replies: BotReply[] } | 'used' | null> {
  if (!Number.isSafeInteger(updateId) || updateId <= 0) return null
  const d = await ctx.store.takeDraft(updateId)
  if (d === 'used') return 'used'
  if (!isDraft(d) || ctx.now.getTime() - Date.parse(d.at) > DRAFT_MS) return null
  const snap = await load(ctx)
  return { text: d.text, replies: await saveAi(ctx, snap, d.items) }
}

/** Voice: length check, transcription, then the usual handling; the first reply starts with «🎤 Услышал: «…»». */
export async function voice(
  ctx: Ctx,
  // deno-lint-ignore no-explicit-any
  media: any,
  file: ((fileId: string) => Promise<Uint8Array>) | undefined,
  handle: (text: string) => Promise<BotReply[]>,
): Promise<BotReply[]> {
  if (!ctx.ai || !file) return [send(ctx, 'Голосовые пока не подключены')]
  if (Number(media?.duration ?? 0) > 60) return [send(ctx, 'Голосовое длиннее минуты — запиши короче')]
  let text = ''
  try {
    const snap = await load(ctx)
    const bytes = await file(String(media.file_id))
    text = (await ctx.ai.transcribe(bytes, media.file_name ?? 'voice.ogg', voicePrompt(aiLists(ctx, snap)))).trim()
  } catch (e) {
    console.error('voice:', e instanceof Error ? e.message : String(e))
  }
  if (!text) return [send(ctx, 'Не расслышал — напиши текстом')]
  const replies = await handle(text)
  const first = replies.find((r) => r.method === 'sendMessage' && r.payload.chat_id === ctx.chatId)
  if (first) {
    const body = String(first.payload.text ?? '').replace(/^📝 «[\s\S]*?»\n/u, '')
    first.payload.text = `🎤 Услышал: «${text}»\n${body}`
  }
  return replies
}
