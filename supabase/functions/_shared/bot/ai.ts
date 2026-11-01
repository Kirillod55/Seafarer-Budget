// «Сначала правила, потом ИИ» (spec §5): when the rules are not sure, Groq parses the text; code checks the
// answer; a sure answer is saved at once («🤖 Понял так:») and teaches the category its word, an unsure one
// waits for «Записать». A plan (new accounts, transfers, with anything else in the message) always waits for
// «Выполнить» and runs exactly as shown. Voice messages are transcribed and go through the same path.
import { askAi, voicePrompt } from '../groq.ts'
import type { AiLists, AiResult } from '../groq.ts'
import { parseRecords } from '../multi.ts'
import { accountKey } from '../fuzzy.ts'
import { money } from '../format.ts'
import type { TxParsed } from '../parser.ts'
import { learn } from './callbacks.ts'
import { createCategory } from './categories.ts'
import { activeAccounts, activeCategories, defaultAccount, describeTx, isMulti, load, send } from './ctx.ts'
import type { Ctx, Keyboard, Snapshot } from './ctx.ts'
import { runCommand } from './intent.ts'
import type { Command } from './intent.ts'
import { saveTransfer } from './money.ts'
import { insertAccounts } from './prefs.ts'
import { buildTx, OTHER_EXPENSE, parseCtx, saveMany, saveOne } from './records.ts'
import type { BotReply } from './types.ts'

export const AI_FAILED = 'Не понял. Можно так:\n• кофе 80\n• создай счёт Монобанк\n• создай категорию Спорт\n• какой курс валют\nВсё остальное — в /help'
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
    const cat = snap.categories.find((c) => c.name === r.category && c.kind === r.kind)
    const acc = r.account ? snap.accounts.find((a) => a.name === r.account) : undefined
    return {
      type: 'tx', kind: r.kind, amount: r.amount, currency: r.currency, categoryId: cat?.id ?? null, accountId: acc?.id ?? null,
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
  if (res.newAccounts.length > 0 || res.transfers.length > 0) return offerPlan(ctx, snap, res, text)

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

const SINGLE_MODE = 'Счета и переводы — в режиме «Несколько счетов» (включается в приложении)'
const NOTHING_TO_DO = 'Нечего делать: такие счета уже есть'
const sameAccount = (a: string, b: string) => accountKey(a) === accountKey(b)

/** What the message asks for, ready to show and run: the names are real accounts or ones the plan creates. */
function planOf(snap: Snapshot, res: AiResult): Plan | null {
  const live = activeAccounts(snap.accounts)
  const exists = (n: string) => live.find((a) => sameAccount(a.name, n))?.name
  const accounts = res.newAccounts.filter((n) => !exists(n))
  const planned = (n: string) => exists(n) ?? accounts.find((a) => sameAccount(a, n))
  const main = defaultAccount(snap.accounts)?.name
  const transfers: Plan['transfers'] = []
  for (const t of res.transfers) {
    if (!planned(t.to)) accounts.push(t.to)
    const from = (t.from && planned(t.from)) || main
    const to = planned(t.to) as string
    if (from && !sameAccount(from, to)) transfers.push({ amount: t.amount, currency: t.currency, from, to })
  }
  if (accounts.length === 0 && transfers.length === 0) return null
  return { accounts, transfers, category: res.createCategory }
}

/** Shows every action; nothing happens before «Выполнить». */
async function offerPlan(ctx: Ctx, snap: Snapshot, res: AiResult, text: string): Promise<BotReply[] | null> {
  if (!isMulti(ctx.settings)) return [send(ctx, SINGLE_MODE)]
  if (ctx.updateId === undefined) return null
  const plan = planOf(snap, res)
  if (!plan) return [send(ctx, NOTHING_TO_DO)]
  const items = toParsed(snap, res)
  await ctx.store.saveDraft(ctx.updateId, { at: ctx.now.toISOString(), text, items, plan } satisfies Draft)
  const lines = [
    ...plan.accounts.map((n) => `Создать счёт «${n}» с нулевым остатком`),
    ...(plan.category ? [`Создать категорию «${plan.category.name}»`] : []),
    ...plan.transfers.map((t) => `Перевод: ${t.from} → ${t.to} · ${money(t.amount, t.currency)}`),
    ...items.flatMap((p) => {
      const tx = buildTx(ctx, snap, p)
      return tx ? [`${describeTx(tx, snap, ctx)}${p.note ? ` · ${p.note}` : ''}`] : []
    }),
  ]
  const why = res.reason ? `\n${res.reason}` : res.dropped ? '\nЧасть не разобрал — проверь' : ''
  return [send(ctx, `📝 «${text}»\n🤖 Понял так:\n${lines.map((l, i) => `${i + 1}) ${l}`).join('\n')}${why}`,
    [[{ text: 'Выполнить', callback_data: `ai:ok:${ctx.updateId}` }, { text: 'Отмена', callback_data: 'no' }]], { replyTo: ctx.messageId })]
}

async function runPlan(ctx: Ctx, snap: Snapshot, plan: Plan, items: TxParsed[]): Promise<BotReply[]> {
  const made = await insertAccounts(ctx, snap, plan.accounts)
  const now = { ...snap, accounts: [...snap.accounts, ...made] }
  const replies: BotReply[] = made.length ? [send(ctx, `Создал счета: ${plan.accounts.join(', ')}. Остаток на каждом — 0`)] : []
  if (plan.category) {
    const kind = plan.category.kind === 'income' ? 'доходов ' : ''
    replies.push(...((await createCategory(ctx, `создай категорию ${kind}«${plan.category.name}»`)) ?? []))
  }
  const named = (n: string) => activeAccounts(now.accounts).find((a) => a.name === n)
  for (const t of plan.transfers) {
    const from = named(t.from)
    const to = named(t.to)
    if (from && to) replies.push(...(await saveTransfer(ctx, now, from, to, t.amount, t.currency)))
    else replies.push(send(ctx, `Не нашёл счёт для перевода: ${t.from} → ${t.to}`))
  }
  return items.length ? [...replies, ...(await saveAi(ctx, now, items))] : replies
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
  plan?: Plan
}

interface Plan {
  accounts: string[]
  transfers: { amount: number; currency: string; from: string; to: string }[]
  category: AiResult['createCategory']
}

export const DRAFT_EXPIRED = 'Черновик устарел — напиши ещё раз'
const DRAFT_MS = 24 * 60 * 60 * 1000

function isDraft(d: unknown): d is Draft {
  // deno-lint-ignore no-explicit-any
  const x = d as any
  return Boolean(x) && typeof x.at === 'string' && typeof x.text === 'string' && Array.isArray(x.items) && (x.items.length > 0 || Boolean(x.plan)) &&
    // deno-lint-ignore no-explicit-any
    x.items.every((p: any) => p?.type === 'tx' && typeof p.amount === 'number' && p.amount > 0 && typeof p.currency === 'string' &&
      typeof p.date === 'string' && (p.kind === 'expense' || p.kind === 'income'))
}

/**
 * «Записать» or «Выполнить»: runs the stored draft once, never asks the AI again.
 * 'used' when it was already saved; null when there is no draft or it is older than 24 h.
 */
export async function confirmDraft(ctx: Ctx, updateId: number): Promise<{ text: string; replies: BotReply[] } | 'used' | null> {
  if (!Number.isSafeInteger(updateId) || updateId <= 0) return null
  const d = await ctx.store.takeDraft(updateId)
  if (d === 'used') return 'used'
  if (!isDraft(d) || ctx.now.getTime() - Date.parse(d.at) > DRAFT_MS) return null
  const snap = await load(ctx)
  return { text: d.text, replies: d.plan ? await runPlan(ctx, snap, d.plan, d.items) : await saveAi(ctx, snap, d.items) }
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
