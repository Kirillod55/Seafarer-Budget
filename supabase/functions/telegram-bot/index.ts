// Supabase Edge Function (Deno): Telegram webhook. Not imported by vitest or type-checked by the app build.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, OWNER_CHAT_ID, OWNER_USER_ID, optional PARTNER_CHAT_ID
// and GROQ_API_KEY (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleUpdate } from '../_shared/bot.ts'
import type { BotReply } from '../_shared/bot.ts'
import type { Author } from '../_shared/types.ts'
import { WHISPER_MODEL } from '../_shared/groq.ts'
import type { GroqPort } from '../_shared/groq.ts'
import { redact } from '../_shared/redact.ts'
import { createStore } from './store.ts'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''
const OWNER_CHAT_ID_RAW = Deno.env.get('OWNER_CHAT_ID') ?? ''
const OWNER_CHAT_ID = Number(OWNER_CHAT_ID_RAW)
const PARTNER_CHAT_ID_RAW = (Deno.env.get('PARTNER_CHAT_ID') ?? '').trim()
const PARTNER_CHAT_ID = PARTNER_CHAT_ID_RAW ? Number(PARTNER_CHAT_ID_RAW) : null
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''

// One-time startup check: names only, never values.
{
  const missing: string[] = []
  if (!TOKEN) missing.push('TELEGRAM_BOT_TOKEN')
  if (!SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET')
  if (!OWNER_CHAT_ID_RAW.trim() || !Number.isFinite(OWNER_CHAT_ID)) missing.push('OWNER_CHAT_ID (must be a number)')
  if (PARTNER_CHAT_ID !== null && !Number.isFinite(PARTNER_CHAT_ID)) missing.push('PARTNER_CHAT_ID (must be a number when set)')
  if (!OWNER_USER_ID) missing.push('OWNER_USER_ID')
  if (missing.length) console.error(`telegram-bot misconfigured, fix these secrets: ${missing.join(', ')}`)
}

const CHATS: Record<number, Author> = { [OWNER_CHAT_ID]: 'owner' }
if (PARTNER_CHAT_ID !== null && Number.isFinite(PARTNER_CHAT_ID)) CHATS[PARTNER_CHAT_ID] = 'partner'

// Deno fetch errors embed the request URL, which contains the bot token: always log through this.
const safe = (e: unknown) => redact(e, [TOKEN, SECRET, GROQ_API_KEY])

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})
const store = createStore(admin, OWNER_USER_ID)

const GROQ_TIMEOUT_MS = 6_000
const GROQ_URL = 'https://api.groq.com/openai/v1'

/** Groq through fetch: 6 s timeout, the key only in the header (never logged). */
const groq: GroqPort | null = GROQ_API_KEY
  ? {
    async chat(model, body) {
      const res = await fetch(`${GROQ_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      })
      return { status: res.status, body: res.ok ? await res.json() : undefined }
    },
    async transcribe(audio, filename, prompt) {
      const form = new FormData()
      form.append('file', new Blob([audio]), filename)
      form.append('model', WHISPER_MODEL)
      form.append('prompt', prompt)
      form.append('response_format', 'json')
      const res = await fetch(`${GROQ_URL}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`groq transcription ${res.status}`)
      return String((await res.json())?.text ?? '')
    },
  }
  : null

/** getWebhookInfo for /ping. */
async function pingInfo() {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`)
  const json = await res.json().catch(() => null)
  return { webhook: res.ok ? (json?.result ?? null) : null, webhookUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/telegram-bot` }
}

/** getFile + download of a voice message (Telegram keeps the token in the URL: never log it). */
async function voiceFile(fileId: string): Promise<Uint8Array> {
  const meta = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)
  const path = (await meta.json())?.result?.file_path
  if (!path) throw new Error('getFile: no file_path')
  const file = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`)
  if (!file.ok) throw new Error(`file download ${file.status}`)
  return new Uint8Array(await file.arrayBuffer())
}
async function telegram(r: BotReply): Promise<void> {
  const url = `https://api.telegram.org/bot${TOKEN}/${r.method}`
  let res: Response
  if (r.method === 'sendDocument') {
    // a CSV built by the bot: multipart upload
    const { document, ...rest } = r.payload as { document: { filename: string; content: string } } & Record<string, unknown>
    const form = new FormData()
    for (const [k, v] of Object.entries(rest)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    form.append('document', new Blob([document.content], { type: 'text/csv' }), document.filename)
    res = await fetch(url, { method: 'POST', body: form })
  } else {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.payload) })
  }
  if (!res.ok) console.error(`telegram ${r.method} failed: ${res.status} ${safe(await res.text())}`)
}

async function deliver(replies: BotReply[]): Promise<void> {
  for (const r of replies) {
    try {
      await telegram(r)
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
    const known = typeof chatId === 'number' && chatId in CHATS
    if (!known) console.log(`update from chat ${chatId} (not a known chat)`) // how Kirill finds Masha's chat id

    try {
      const replies = await handleUpdate(update, CHATS, store, new Date(), () => crypto.randomUUID(), { groq, voiceFile, pingInfo })
      await deliver(replies)
    } catch (e) {
      console.error('handleUpdate failed:', safe(e))
      if (known) {
        await deliver([
          { method: 'sendMessage', payload: { chat_id: chatId, text: 'Что-то пошло не так — проверь в приложении, сохранилась ли запись' } },
        ])
      }
    }
  } catch (e) {
    console.error('bad webhook request:', safe(e))
  }
  // always 200 so Telegram does not retry
  return new Response('ok', { status: 200 })
})
