// Supabase Edge Function (Deno): Telegram webhook. Not imported by vitest or type-checked by the app build.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, OWNER_CHAT_ID, OWNER_USER_ID
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleUpdate } from '../_shared/bot.ts'
import type { BotReply } from '../_shared/bot.ts'
import { createStore } from './store.ts'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''
const OWNER_CHAT_ID = Number(Deno.env.get('OWNER_CHAT_ID'))
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})
const store = createStore(admin, OWNER_USER_ID)

async function telegram(method: string, payload: Record<string, unknown>): Promise<void> {
  // the URL contains the token: never log it
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) console.error(`telegram ${method} failed: ${res.status} ${await res.text()}`)
}

async function deliver(replies: BotReply[]): Promise<void> {
  for (const r of replies) {
    try {
      await telegram(r.method, r.payload)
    } catch (e) {
      console.error(`telegram ${r.method} error:`, e instanceof Error ? e.message : String(e))
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const update = await req.json()
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id
    if (chatId !== OWNER_CHAT_ID) console.log(`update from chat ${chatId} (not the owner)`) // how Kirill finds his chat id

    try {
      const replies = await handleUpdate(update, OWNER_CHAT_ID, store, new Date(), () => crypto.randomUUID())
      await deliver(replies)
    } catch (e) {
      console.error('handleUpdate failed:', e instanceof Error ? e.message : String(e))
      if (chatId === OWNER_CHAT_ID) {
        await deliver([{ method: 'sendMessage', payload: { chat_id: chatId, text: 'Что-то пошло не так, запись не сохранена. Попробуй ещё раз.' } }])
      }
    }
  } catch (e) {
    console.error('bad webhook request:', e instanceof Error ? e.message : String(e))
  }
  // always 200 so Telegram does not retry
  return new Response('ok', { status: 200 })
})
