// Supabase Edge Function (Deno), deployed with --no-verify-jwt: the daily ping of spec §10.
// Called by .github/workflows/keepalive.yml at 07:17 and 19:17 UTC with X-Keepalive-Secret.
// Secrets: KEEPALIVE_SECRET, TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, OWNER_USER_ID, optional PARTNER_CHAT_ID.
// The client uses the SERVICE ROLE: set_rev() keeps keepalive_at / last_reminder_at for any other writer.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleKeepalive } from '../_shared/keepalive.ts'
import type { KeepaliveDeps } from '../_shared/keepalive.ts'
import { loadBankRates } from '../_shared/bankRates.ts'
import { bnmUrl, nbuUrl, parseBnm, parseNbu } from '../_shared/fx.ts'
import { redact } from '../_shared/redact.ts'
import { createStore } from '../telegram-bot/store.ts'

const SECRET = Deno.env.get('KEEPALIVE_SECRET') ?? ''
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_CHAT_ID = Number(Deno.env.get('OWNER_CHAT_ID') ?? '')
const PARTNER_RAW = (Deno.env.get('PARTNER_CHAT_ID') ?? '').trim()
const PARTNER_CHAT_ID = PARTNER_RAW && Number.isFinite(Number(PARTNER_RAW)) ? Number(PARTNER_RAW) : null
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/telegram-bot`

const safe = (e: unknown) => redact(e, [TOKEN, SECRET])
const db = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const store = createStore(db, OWNER_USER_ID)

function check(what: string, error: { message: string } | null) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function tg(method: string, body: Record<string, unknown> | FormData): Promise<unknown> {
  const init: RequestInit = body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, init)
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}`)
  return json
}

let settingsId: string | null = null

const deps: KeepaliveDeps = {
  async settings() {
    const s = await store.settings()
    settingsId = s?.id ?? null
    return s
  },
  async updateSettings(patch) {
    if (settingsId) await store.update('settings', settingsId, patch)
  },
  transactions: () => store.transactions(),
  goalMoves: () => store.goalMoves(),
  goals: () => store.goals(),
  categories: () => store.categories(),
  accounts: () => store.accounts(),
  limits: () => store.limits(),
  rates: () => store.rates(),
  binned: (t) => store.binned(t),
  async markDeleted(t, ids, olderThan) {
    for (let i = 0; i < ids.length; i += 200) {
      // guarded at write time: a row restored (deleted_at = null) or re-binned since the read is left alone
      const { error } = await db.from(t).update({ deleted: true }).in('id', ids.slice(i, i + 200)).eq('user_id', OWNER_USER_ID)
        .not('deleted_at', 'is', null).lt('deleted_at', olderThan)
      check(`purge ${t}`, error)
    }
  },
  async fetchNbu(date, currencies) {
    const res = await fetch(nbuUrl(date), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`NBU ${res.status}`)
    return parseNbu(await res.json(), currencies)
  },
  async fetchBnm(date) {
    const res = await fetch(bnmUrl(date), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`BNM ${res.status}`)
    return parseBnm(await res.text(), date)
  },
  bankRates: () => loadBankRates(),
  async cronToken() {
    const { data, error } = await db.from('cron_tokens').select('value').eq('name', 'rates').maybeSingle()
    check('read cron token', error)
    return (data?.value as string | undefined) ?? null
  },
  async writeRates(r) {
    const { error } = await db.from('fx_rates').upsert(r, { onConflict: 'date,currency' })
    check('write fx_rates', error)
  },
  patchTx: (id, patch) => store.updateTx(id, patch),
  async deleteBotUpdatesBefore(iso) {
    const { error } = await db.from('bot_updates').delete().lt('created_at', iso)
    check('clean bot_updates', error)
  },
  async webhookInfo() {
    // deno-lint-ignore no-explicit-any
    const r = (await tg('getWebhookInfo', {})) as any
    return r?.result ?? { url: '', pending_update_count: 0 }
  },
  async send(chatId, text) {
    await tg('sendMessage', { chat_id: chatId, text })
  },
  async sendDocument(chatId, filename, content, caption) {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('caption', caption)
    form.append('document', new Blob([content], { type: filename.endsWith('.json') ? 'application/json' : 'text/csv' }), filename)
    await tg('sendDocument', form)
  },
}

Deno.serve(async (req: Request) => {
  try {
    return await handleKeepalive(req, deps, {
      now: new Date(), ownerChatId: OWNER_CHAT_ID, partnerChatId: PARTNER_CHAT_ID, webhookUrl: WEBHOOK_URL,
    }, SECRET)
  } catch (e) {
    console.error('keepalive error:', safe(e))
    return new Response(JSON.stringify({ ok: false }), { status: 500 })
  }
})
