import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from './defaults.ts'
import { handleKeepalive, reminderDue, runKeepalive, webhookProblem } from './keepalive.ts'
import type { KeepaliveDeps, KeepaliveOptions } from './keepalive.ts'
import type { Account, Category, FxRate, Settings, SoftTable, Transaction } from './types.ts'

const OWNER = 1
const PARTNER = 2
const DAY = 86_400_000
const MORNING = new Date('2026-10-21T07:17:00Z') // Wednesday
const EVENING = new Date('2026-10-21T19:17:00Z')
const SUNDAY = new Date('2026-10-25T07:17:00Z')

const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${Math.random()}`, deleted: false, kind: 'expense', amount: 10, currency: 'USD', rate_usd: 1, amount_usd: 10, rate_pending: false,
  account_id: 'a1', to_account_id: null, to_amount: null, to_currency: null, category_id: null, date: '2026-10-21', note: '',
  source: 'app', created_at: '2026-10-21T06:00:00.000Z', author: 'owner', archived: false, deleted_at: null, deleted_batch: null, ...over,
})

class Fake implements KeepaliveDeps {
  settingsRow: Settings = { id: 's1', deleted: false, ...DEFAULT_SETTINGS, partner_name: 'Маша' }
  txs: Transaction[] = []
  bin: Record<string, { id: string; deleted: boolean; deleted_at: string | null; deleted_batch: string | null }[]> = {}
  fx: FxRate[] = [{ date: '2026-10-21', currency: 'USD', uah_per_unit: 41.2 }, { date: '2026-10-21', currency: 'UAH', uah_per_unit: 1 }]
  sent: { chat: number; text: string }[] = []
  docs: { chat: number; filename: string; content: string; caption: string }[] = []
  nbuCalls: string[] = []
  purged: Record<string, string[]> = {}
  patched: Record<string, Partial<Transaction>> = {}
  updatesBefore: string | null = null
  hook = { url: 'https://x.supabase.co/functions/v1/telegram-bot', pending_update_count: 0 } as { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }

  async settings() { return this.settingsRow }
  async updateSettings(p: Partial<Settings>) { this.settingsRow = { ...this.settingsRow, ...p } }
  async transactions() { return this.txs }
  async goalMoves() { return [] }
  async goals() { return [] }
  async categories(): Promise<Category[]> { return DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `c${i}`, deleted: false })) }
  async accounts(): Promise<Account[]> { return [{ id: 'a1', deleted: false, name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0 }] }
  async rates() { return this.fx }
  async binned(t: SoftTable) { return this.bin[t] ?? [] }
  purgeCutoff = ''
  async markDeleted(t: SoftTable, ids: string[], olderThan: string) {
    this.purged[t] = ids
    this.purgeCutoff = olderThan
  }
  async fetchNbu(date: string) {
    this.nbuCalls.push(date)
    return [{ date, currency: 'USD', uah_per_unit: 40 }, { date, currency: 'UAH', uah_per_unit: 1 }, { date, currency: 'EUR', uah_per_unit: 44 }]
  }
  async writeRates(rows: FxRate[]) { this.fx.push(...rows) }
  async patchTx(id: string, p: Partial<Transaction>) { this.patched[id] = p }
  async deleteBotUpdatesBefore(iso: string) { this.updatesBefore = iso }
  async webhookInfo() { return this.hook }
  async send(chat: number, text: string) { this.sent.push({ chat, text }) }
  async sendDocument(chat: number, filename: string, content: string, caption: string) { this.docs.push({ chat, filename, content, caption }) }
}
const opts = (now: Date, over: Partial<KeepaliveOptions> = {}): KeepaliveOptions => ({
  now, ownerChatId: OWNER, partnerChatId: PARTNER, webhookUrl: 'https://x.supabase.co/functions/v1/telegram-bot', ...over,
})

describe('reminderDue (spec §10)', () => {
  const now = Date.parse('2026-10-21T07:17:00Z')
  const ago = (d: number) => new Date(now - d * DAY).toISOString()
  it('2 days without records → due; the next day silent; 2 more days → due again; a new record resets; 0 never', () => {
    expect(reminderDue(ago(2), null, 2, now)).toBe(true)
    expect(reminderDue(ago(1.9), null, 2, now)).toBe(false)
    expect(reminderDue(ago(3), ago(1), 2, now)).toBe(false)
    expect(reminderDue(ago(4), ago(2), 2, now)).toBe(true)
    expect(reminderDue(ago(2.5), ago(3), 2, now)).toBe(true)
    expect(reminderDue(ago(10), null, 0, now)).toBe(false)
    expect(reminderDue(null, null, 2, now)).toBe(false)
  })
})

describe('runKeepalive', () => {
  it('writes keepalive_at and reminds both people once', async () => {
    const f = new Fake()
    f.txs = [tx({ created_at: '2026-10-18T07:00:00.000Z', date: '2026-10-18' })]
    await runKeepalive(f, opts(MORNING))
    expect(f.settingsRow.keepalive_at).toBe(MORNING.toISOString())
    expect(f.settingsRow.last_reminder_at).toBe(MORNING.toISOString())
    expect(f.sent.filter((m) => m.text.startsWith('2 дня без записей'))).toEqual([
      { chat: OWNER, text: '2 дня без записей — всё в порядке? Запиши траты (можно голосом) или проверь связь: /ping' },
      { chat: PARTNER, text: '2 дня без записей — всё в порядке? Запиши траты (можно голосом) или проверь связь: /ping' },
    ])
    f.sent = []
    await runKeepalive(f, opts(EVENING))
    expect(f.sent).toEqual([])
    const solo = new Fake()
    solo.txs = f.txs
    await runKeepalive(solo, opts(MORNING, { partnerChatId: null }))
    expect(solo.sent.map((m) => m.chat)).toEqual([OWNER])
  })

  it('evening: the daily summary only to those who turned it on', async () => {
    const f = new Fake()
    f.settingsRow = { ...f.settingsRow, daily_summary_partner: true, next_contract_date: '2026-10-31' }
    f.txs = [
      tx({ kind: 'income', amount: 1000, amount_usd: 1000, date: '2026-10-01', created_at: '2026-10-01T00:00:00.000Z' }),
      tx({ amount: 25, amount_usd: 25 }),
      tx({ amount: 11.68, amount_usd: 11.68, author: 'partner' }),
    ]
    await runKeepalive(f, opts(EVENING))
    expect(f.sent).toEqual([{ chat: PARTNER, text: '📅 Итог дня: потрачено $36.68 (Я $25 · Маша $11.68) · на завтра $96.33 в день · записей: 2' }])
    const empty = new Fake()
    empty.settingsRow = { ...empty.settingsRow, daily_summary_owner: true, remind_after_days: 0 }
    await runKeepalive(empty, opts(EVENING))
    expect(empty.sent).toEqual([{ chat: OWNER, text: '📅 Сегодня записей не было — ничего не забыли?' }])
  })

  it('morning: pending rates fixed with one NBU call per date; bin > 24 h purged; bot_updates > 30 days removed', async () => {
    const f = new Fake()
    f.txs = [
      tx({ id: 'p1', currency: 'EUR', amount: 10, rate_usd: 0, amount_usd: 0, rate_pending: true, date: '2026-10-19' }),
      tx({ id: 'p2', currency: 'EUR', amount: 20, rate_usd: 0, amount_usd: 0, rate_pending: true, date: '2026-10-19' }),
    ]
    f.bin = { transactions: [
      { id: 'old', deleted: false, deleted_at: '2026-10-20T07:00:00.000Z', deleted_batch: 'b' },
      { id: 'new', deleted: false, deleted_at: '2026-10-21T07:00:00.000Z', deleted_batch: 'b2' },
    ] }
    const r = await runKeepalive(f, opts(MORNING))
    expect(f.nbuCalls).toEqual(['2026-10-19'])
    expect(f.patched.p1).toEqual({ rate_usd: 1.1, amount_usd: 11, rate_pending: false })
    expect(f.patched.p2).toEqual({ rate_usd: 1.1, amount_usd: 22, rate_pending: false })
    expect(f.purged.transactions).toEqual(['old'])
    // the write itself is guarded: only rows still binned before the cutoff (a restore in between wins)
    expect(f.purgeCutoff).toBe('2026-10-20T07:17:00.000Z')
    expect(f.updatesBefore).toBe('2026-09-21T07:17:00.000Z')
    expect(r.done).toEqual(expect.arrayContaining(['keepalive', 'webhook', 'rates', 'purge', 'bot_updates']))
  })

  it('webhook problems → one message to Kirill', async () => {
    const now = MORNING.getTime()
    expect(webhookProblem({ url: 'https://other', pending_update_count: 0 }, 'https://mine', now)).toContain('адрес')
    expect(webhookProblem({ url: 'https://mine', pending_update_count: 0, last_error_date: now / 1000 - 3600, last_error_message: 'Wrong response' }, 'https://mine', now)).toBe('Wrong response')
    expect(webhookProblem({ url: 'https://mine', pending_update_count: 0, last_error_date: now / 1000 - 2 * 86400, last_error_message: 'old' }, 'https://mine', now)).toBeNull()
    expect(webhookProblem({ url: 'https://mine', pending_update_count: 6 }, 'https://mine', now)).toContain('6')
    const f = new Fake()
    f.settingsRow = { ...f.settingsRow, remind_after_days: 0 }
    f.hook = { url: 'https://other', pending_update_count: 0 }
    await runKeepalive(f, opts(MORNING))
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({ chat: OWNER })
    expect(f.sent[0].text.startsWith('⚠️ Telegram не может доставить сообщения боту:')).toBe(true)
  })

  it('Sunday morning: a CSV backup only to Kirill, a row per record', async () => {
    const f = new Fake()
    f.settingsRow = { ...f.settingsRow, remind_after_days: 0 }
    f.txs = [tx({ created_at: '2026-10-25T06:00:00.000Z', date: '2026-10-25' }), tx({ date: '2026-10-24' }), tx({ date: '2026-10-23' })]
    await runKeepalive(f, opts(SUNDAY))
    expect(f.docs).toHaveLength(1)
    expect(f.docs[0]).toMatchObject({ chat: OWNER, filename: 'seafarer-budget-2026-10-25.csv', caption: 'Резервная копия · 3 записи · открыть в Excel' })
    expect(f.docs[0].content.split('\r\n').filter(Boolean)).toHaveLength(4)
    const weekday = new Fake()
    await runKeepalive(weekday, opts(MORNING))
    expect(weekday.docs).toHaveLength(0)
  })
})

describe('handleKeepalive', () => {
  const req = (secret?: string, method = 'POST') =>
    new Request('https://x/functions/v1/keepalive', { method, headers: secret ? { 'X-Keepalive-Secret': secret } : {} })
  it('401 without or with a wrong secret, nothing written', async () => {
    const f = new Fake()
    expect((await handleKeepalive(req(), f, opts(MORNING), 's3cret')).status).toBe(401)
    expect((await handleKeepalive(req('nope'), f, opts(MORNING), 's3cret')).status).toBe(401)
    expect((await handleKeepalive(req('s3cret'), f, opts(MORNING), '')).status).toBe(401)
    expect(f.settingsRow.keepalive_at).toBeNull()
  })
  it('with the secret: ok and db_ms; GET is refused', async () => {
    const f = new Fake()
    const res = await handleKeepalive(req('s3cret'), f, opts(MORNING), 's3cret')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.db_ms).toBe('number')
    expect(f.settingsRow.keepalive_at).toBe(MORNING.toISOString())
    expect((await handleKeepalive(req('s3cret', 'GET'), f, opts(MORNING), 's3cret')).status).toBe(405)
  })
})
