// Supabase Edge Function (Deno), deployed with --no-verify-jwt: the daily ping of spec §10.
// Called by .github/workflows/keepalive.yml at 07:17 and 19:17 UTC with X-Keepalive-Secret.
// Secrets: KEEPALIVE_SECRET, TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, OWNER_USER_ID, optional PARTNER_CHAT_ID.
// The client uses the SERVICE ROLE: set_rev() keeps keepalive_at / last_reminder_at for any other writer.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleKeepalive } from '../_shared/keepalive.ts'
import type { KeepaliveDeps } from '../_shared/keepalive.ts'
import { nbuUrl, parseNbu } from '../_shared/fx.ts'
import { redact } from '../_shared/redact.ts'
import type { FxRate, Settings, SoftTable, Transaction } from '../_shared/types.ts'

const SECRET = Deno.env.get('KEEPALIVE_SECRET') ?? ''
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_CHAT_ID = Number(Deno.env.get('OWNER_CHAT_ID') ?? '')
const PARTNER_RAW = (Deno.env.get('PARTNER_CHAT_ID') ?? '').trim()
const PARTNER_CHAT_ID = PARTNER_RAW && Number.isFinite(Number(PARTNER_RAW)) ? Number(PARTNER_RAW) : null
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/telegram-bot`
const PAGE = 1000

const safe = (e: unknown) => redact(e, [TOKEN, SECRET])
const db = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

function check(what: string, error: { message: string } | null) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function rows<T>(table: string, live: boolean, soft = false): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select('*').eq('user_id', OWNER_USER_ID).eq('deleted', false)
    if (soft) q = live ? q.is('deleted_at', null) : q.not('deleted_at', 'is', null)
    const { data, error } = await q.order('rev', { ascending: true }).range(from, from + PAGE - 1)
    check(`read ${table}`, error)
    out.push(...((data ?? []) as T[]))
    if ((data ?? []).length < PAGE) return out
  }
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
    const { data, error } = await db.from('settings').select('*').eq('user_id', OWNER_USER_ID).eq('deleted', false)
      .order('rev', { ascending: false }).limit(1)
    check('read settings', error)
    const s = ((data ?? [])[0] as Settings | undefined) ?? null
    settingsId = s?.id ?? null
    return s
  },
  async updateSettings(patch) {
    if (!settingsId) return
    const { error } = await db.from('settings').update(patch).eq('id', settingsId).eq('user_id', OWNER_USER_ID)
    check('update settings', error)
  },
  transactions: () => rows<Transaction>('transactions', true, true),
  goalMoves: () => rows('goal_moves', true),
  goals: () => rows('goals', true, true),
  categories: () => rows('categories', true, true),
  accounts: () => rows('accounts', true),
  async rates() {
    const { data, error } = await db.from('fx_rates').select('date,currency,uah_per_unit').order('date', { ascending: false }).limit(2000)
    check('read fx_rates', error)
    return ((data ?? []) as FxRate[]).map((r) => ({ ...r, uah_per_unit: Number(r.uah_per_unit) }))
  },
  binned: (t: SoftTable) => rows(t, false, true),
  async markDeleted(t, ids) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.from(t).update({ deleted: true }).in('id', ids.slice(i, i + 200)).eq('user_id', OWNER_USER_ID)
      check(`purge ${t}`, error)
    }
  },
  async fetchNbu(date, currencies) {
    const res = await fetch(nbuUrl(date), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`NBU ${res.status}`)
    return parseNbu(await res.json(), currencies)
  },
  async writeRates(r) {
    const { error } = await db.from('fx_rates').upsert(r, { onConflict: 'date,currency' })
    check('write fx_rates', error)
  },
  async patchTx(id, patch) {
    const { error } = await db.from('transactions').update(patch).eq('id', id).eq('user_id', OWNER_USER_ID)
    check('patch transaction', error)
  },
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
    form.append('document', new Blob([content], { type: 'text/csv' }), filename)
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
