// Supabase Edge Function (Deno): Telegram webhook. Not imported by vitest or type-checked by the app build.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, OWNER_CHAT_ID, OWNER_USER_ID
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleUpdate } from '../_shared/bot.ts'
import type { BotReply } from '../_shared/bot.ts'
import { redact } from '../_shared/redact.ts'
import { createStore } from './store.ts'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''
const OWNER_CHAT_ID_RAW = Deno.env.get('OWNER_CHAT_ID') ?? ''
const OWNER_CHAT_ID = Number(OWNER_CHAT_ID_RAW)
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// One-time startup check: names only, never values.
{
  const missing: string[] = []
  if (!TOKEN) missing.push('TELEGRAM_BOT_TOKEN')
  if (!SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET')
  if (!OWNER_CHAT_ID_RAW.trim() || !Number.isFinite(OWNER_CHAT_ID)) missing.push('OWNER_CHAT_ID (must be a number)')
  if (!OWNER_USER_ID) missing.push('OWNER_USER_ID')
  if (missing.length) console.error(`telegram-bot misconfigured, fix these secrets: ${missing.join(', ')}`)
}

// Deno fetch errors embed the request URL, which contains the bot token: always log through this.
const safe = (e: unknown) => redact(e, [TOKEN, SECRET])

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})
const store = createStore(admin, OWNER_USER_ID)

async function telegram(method: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) console.error(`telegram ${method} failed: ${res.status} ${safe(await res.text())}`)
}

async function deliver(replies: BotReply[]): Promise<void> {
  for (const r of replies) {
    try {
      await telegram(r.method, r.payload)
    } catch (e) {
      console.error(`telegram ${r.method} error:`, safe(e))
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
      console.error('handleUpdate failed:', safe(e))
      if (chatId === OWNER_CHAT_ID) {
        await deliver([
          {
            method: 'sendMessage',
            payload: { chat_id: chatId, text: 'Что-то пошло не так — проверь в приложении, сохранилась ли запись' },
          },
        ])
      }
    }
  } catch (e) {
    console.error('bad webhook request:', safe(e))
  }
  // always 200 so Telegram does not retry
  return new Response('ok', { status: 200 })
})
