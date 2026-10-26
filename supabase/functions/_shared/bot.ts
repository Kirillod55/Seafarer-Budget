// Telegram bot entry: pure, storage and transport are injected (BotStore, BotReply). The logic lives in
// ./bot/*.ts. Runs in Deno (Edge Function) and in vitest. No npm imports.
import type { Author } from './types.ts'
import { localDate } from './dates.ts'
import { answer, edit, recordCallback, sourceText } from './bot/callbacks.ts'
import type { Query } from './bot/callbacks.ts'
import { categoryCallback } from './bot/categories.ts'
import { clearCallback } from './bot/clear.ts'
import { send } from './bot/ctx.ts'
import type { Ctx, Keyboard } from './bot/ctx.ts'
import { AI_FAILED, aiAnswer, voice } from './bot/ai.ts'
import { fallback, route, runCommand } from './bot/intent.ts'
import type { Command } from './bot/intent.ts'
import type { GroqPort } from './groq.ts'
import type { PingInfo } from './bot/ping.ts'
import { prefCallback } from './bot/prefs.ts'
import { replyEdit } from './bot/replyEdit.ts'
import { NEED_APP } from './bot/texts.ts'
import type { BotReply, BotStore } from './bot/types.ts'

export type { BotReply, BotStore, WriteTable } from './bot/types.ts'
export { restorePatch } from './bot/types.ts'

/** Chat id -> who writes there. A plain number is the 1.0 form: the owner's chat only. */
export type Chats = number | Record<number, Author>

export interface BotOptions {
  /** Groq (GROQ_API_KEY set): voice and the AI parser are on (stage 5) */
  groq?: GroqPort | null
  /** downloads a Telegram file (getFile + file URL) for voice messages */
  voiceFile?: (fileId: string) => Promise<Uint8Array>
  /** getWebhookInfo for /ping */
  pingInfo?: () => Promise<PingInfo>
}

function chatMap(chats: Chats): { authorOf: (id: unknown) => Author | null; owner: number; partner: number | null } {
  if (typeof chats === 'number') return { authorOf: (id) => (id === chats ? 'owner' : null), owner: chats, partner: null }
  const entries = Object.entries(chats).map(([k, v]) => [Number(k), v] as const)
  const owner = entries.find(([, v]) => v === 'owner')?.[0] ?? NaN
  const partner = entries.find(([, v]) => v === 'partner')?.[0] ?? null
  return { authorOf: (id) => (typeof id === 'number' ? (chats[id] ?? null) : null), owner, partner }
}

export async function handleUpdate(
  // deno-lint-ignore no-explicit-any
  update: any,
  chats: Chats,
  store: BotStore,
  now: Date,
  uuid: () => string,
  opts: BotOptions = {},
): Promise<BotReply[]> {
  const chatId: unknown = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id
  const map = chatMap(chats)
  const author = map.authorOf(chatId)
  if (!author) return []
  const text: unknown = update?.message?.text
  const media = update?.message?.voice ?? update?.message?.audio
  const isCallback = Boolean(update?.callback_query)
  if (!isCallback && typeof text !== 'string' && !media) return []

  if (typeof update.update_id === 'number' && (await store.seenUpdate(update.update_id))) return []

  const settings = await store.settings()
  if (!settings) {
    if (isCallback) return [answer(update.callback_query, NEED_APP)]
    return [{ method: 'sendMessage', payload: { chat_id: chatId, text: NEED_APP } }]
  }
  if (author === 'partner') {
    try {
      await store.update('settings', settings.id, { partner_seen_at: now.toISOString() })
    } catch (e) {
      console.error('partner_seen_at:', e instanceof Error ? e.message : String(e))
    }
  }

  const ctx: Ctx = {
    chatId: chatId as number, author, ownerChatId: map.owner, partnerChatId: map.partner, settings, store, now,
    today: localDate(now, settings.timezone), uuid, groq: Boolean(opts.groq), ai: opts.groq ?? null, pingInfo: opts.pingInfo, messageId: update?.message?.message_id,
  }
  if (isCallback) return handleCallback(ctx, update.callback_query)
  if (typeof text !== 'string') return voice(ctx, media, opts.voiceFile, (heard) => handleText(ctx, heard))
  return handleText(ctx, text as string, update.message)
}

// deno-lint-ignore no-explicit-any
export async function handleText(ctx: Ctx, text: string, message?: any): Promise<BotReply[]> {
  const replied = message?.reply_to_message
  if (replied?.reply_markup) {
    const r = await replyEdit(ctx, text, replied)
    if (r) return r
  }
  return (await route(ctx, text)) ?? fallback(ctx, text)
}

async function handleCallback(ctx: Ctx, q: Query): Promise<BotReply[]> {
  const data = typeof q.data === 'string' ? q.data : ''
  if (data === 'no') return [answer(q), edit(ctx, q, 'Отменено — ничего не изменилось')]
  if (data === 'ok') {
    const source = sourceText(q)
    if (!source) return [answer(q, 'Не нашёл исходное сообщение — напиши ещё раз')]
    const r = (await route({ ...ctx, messageId: undefined }, source, true)) ?? []
    const first = r[0]
    if (first?.method === 'sendMessage') {
      const kb = (first.payload.reply_markup as { inline_keyboard: Keyboard } | undefined)?.inline_keyboard
      return [answer(q, 'Сохранено'), edit(ctx, q, String(first.payload.text), kb), ...r.slice(1)]
    }
    return [answer(q, 'Сохранено'), ...r]
  }
  for (const h of [recordCallback, clearCallback, categoryCallback, prefCallback]) {
    const r = await h(ctx, q, data)
    if (r) return r
  }
  if (data === 'ai:ok') {
    const source = sourceText(q)
    const r = source ? await aiAnswer({ ...ctx, messageId: undefined }, source, true) : null
    if (!r) return [answer(q), edit(ctx, q, AI_FAILED)]
    return [answer(q, 'Записал'), edit(ctx, q, `📝 «${source}» — записал`), ...r]
  }
  if (data.startsWith('cmd:')) return [answer(q), ...(await runCommand(ctx, data.slice(4) as Command))]
  if (data.startsWith('se:')) return [answer(q, 'Ответь на сообщение с номером: «2 90», «2 вчера», «2 наличные»')]
  return [answer(q)]
}

export { send }
