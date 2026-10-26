// In-memory BotStore and helpers for the bot tests (not shipped to Deno: nothing imports it but *.test.ts).
import { alive } from '../alive.ts'
import { handleUpdate } from '../bot.ts'
import type { Chats } from '../bot.ts'
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../defaults.ts'
import type { Account, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from '../types.ts'
import type { BotReply, BotStore, WriteTable } from './types.ts'

export const OWNER = 777
export const PARTNER = 888
export const NOW = new Date('2026-10-21T10:00:00Z') // 13:00 in Kyiv, Wednesday 2026-10-21
export const TODAY = '2026-10-21'

export const SETTINGS: Settings = { id: 's1', deleted: false, ...DEFAULT_SETTINGS }
export const ACCOUNT: Account = { id: 'acc1', deleted: false, name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0 }
export const CATEGORIES: Category[] = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat${String(i).padStart(2, '0')}`, deleted: false }))
export const cat = (name: string) => CATEGORIES.find((c) => c.name === name)!
export const RATES: FxRate[] = [
  { date: TODAY, currency: 'UAH', uah_per_unit: 1 },
  { date: TODAY, currency: 'USD', uah_per_unit: 41.2 },
  { date: TODAY, currency: 'EUR', uah_per_unit: 44.9 },
  { date: TODAY, currency: 'MDL', uah_per_unit: 2.35 },
]

type Row = { id: string; deleted: boolean; rev?: number; [k: string]: unknown }

export class MemStore implements BotStore {
  seen = new Set<number>()
  settingsRow: Settings | null = { ...SETTINGS }
  accountRows: Account[] = [{ ...ACCOUNT }]
  categoryRows: Category[] = CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] }))
  goalRows: Goal[] = []
  moveRows: GoalMove[] = []
  limitRows: Limit[] = []
  txRows: Transaction[] = []
  rateRows: FxRate[] = RATES
  writes: { table: WriteTable; id: string; patch: object }[] = []
  private rev = 100

  drafts = new Map<number, object | null>()
  async saveDraft(id: number, draft: object) {
    if (this.seen.has(id)) this.drafts.set(id, JSON.parse(JSON.stringify(draft)))
  }
  async takeDraft(id: number) {
    if (!this.drafts.has(id)) return null
    const d = this.drafts.get(id)
    if (d === null) return 'used'
    this.drafts.set(id, null)
    return d
  }
  async seenUpdate(id: number) {
    if (this.seen.has(id)) return true
    this.seen.add(id)
    return false
  }
  async settings() { return this.settingsRow }
  async categories() { return this.categoryRows.filter(alive) }
  async accounts() { return this.accountRows.filter((a) => !a.deleted) }
  async goals() { return this.goalRows.filter(alive) }
  async goalMoves() { return this.moveRows.filter((m) => !m.deleted) }
  async limits() { return this.limitRows.filter(alive) }
  async transactions() { return this.txRows.filter(alive) }
  async binnedTransactions() { return this.txRows.filter((t) => !t.deleted && t.deleted_at !== null) }
  async rates() { return this.rateRows }
  async insertTx(t: Transaction) { this.txRows.push({ ...t, rev: ++this.rev }) }
  async updateTx(id: string, patch: Partial<Transaction>) { await this.update('transactions', id, patch) }
  async insertGoalMove(m: GoalMove) { this.moveRows.push(m) }
  async updateCategory(id: string, patch: Partial<Category>) { await this.update('categories', id, patch) }

  private table(t: WriteTable): { get: () => Row[]; set: (rows: Row[]) => void } {
    const map = {
      transactions: 'txRows', categories: 'categoryRows', accounts: 'accountRows', goals: 'goalRows', goal_moves: 'moveRows',
      limits: 'limitRows',
    } as const
    if (t === 'settings') {
      return { get: () => (this.settingsRow ? [this.settingsRow as unknown as Row] : []), set: (rows) => { this.settingsRow = rows[0] as unknown as Settings } }
    }
    const key = map[t]
    // deno-lint-ignore no-explicit-any
    const self = this as any
    return { get: () => self[key], set: (rows) => { self[key] = rows } }
  }
  async insert(table: WriteTable, row: object) {
    const t = this.table(table)
    t.set([...t.get(), { ...(row as Row), rev: ++this.rev }])
  }
  async update(table: WriteTable, id: string, patch: object) {
    this.writes.push({ table, id, patch })
    const t = this.table(table)
    // a restore from the bin needs base_rev (set_rev() rule 2)
    const p = { ...(patch as Record<string, unknown>) }
    t.set(t.get().map((r) => {
      if (r.id !== id) return r
      if (r.deleted_at && p.deleted_at === null && (p.base_rev === undefined || p.base_rev === null)) {
        delete p.deleted_at
        delete p.deleted_batch
      }
      delete p.base_rev
      return { ...r, ...p, rev: ++this.rev }
    }))
  }
}

export function seedTx(over: Partial<Transaction>): Transaction {
  return {
    id: `seed-${Math.random().toString(36).slice(2)}`, deleted: false, kind: 'expense', amount: 0, currency: 'USD', rate_usd: 1,
    amount_usd: 0, rate_pending: false, account_id: 'acc1', to_account_id: null, to_amount: null, to_currency: null,
    category_id: null, date: TODAY, note: '', source: 'app', created_at: '2026-10-01T00:00:00.000Z',
    author: 'owner', archived: false, deleted_at: null, deleted_batch: null, rev: 1, ...over,
  }
}

let n = 0
/** uuid-shaped ids (the buttons read 36-char ids) */
export const uuid = () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`
let updateSeq = 1000
export const msg = (text: string, chatId = OWNER, extra: Record<string, unknown> = {}) => ({
  update_id: ++updateSeq,
  message: { message_id: 5, chat: { id: chatId }, text, ...extra },
})
// deno-lint-ignore no-explicit-any
export const cb = (data: string, message: any = {}, chatId = OWNER) => ({
  update_id: ++updateSeq,
  callback_query: { id: 'cbq1', data, message: { message_id: 9, chat: { id: chatId }, ...message } },
})
export const CHATS: Chats = { [OWNER]: 'owner', [PARTNER]: 'partner' }
export const run = (store: BotStore, update: unknown, now = NOW, opts = {}) => handleUpdate(update, CHATS, store, now, uuid, opts)
export const textOf = (r: BotReply[]) => r.map((x) => String(x.payload.text ?? '')).join('\n')
export const kbOf = (r: BotReply) => (r.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []
export const buttons = (r: BotReply[]) => r.flatMap((x) => kbOf(x).flat())
/** The bot message as Telegram would show it later (for callbacks / replies on it). */
export const asMessage = (r: BotReply, id = 9) => ({ message_id: id, text: r.payload.text, reply_markup: r.payload.reply_markup })
