import { describe, expect, it } from 'vitest'
import { handleUpdate } from './bot.ts'
import type { BotReply, BotStore } from './bot.ts'
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from './defaults.ts'
import type { Account, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from './types.ts'

const OWNER = 777
const NOW = new Date('2026-10-21T10:00:00Z') // 13:00 in Europe/Kyiv, still 2026-10-21
const TODAY = '2026-10-21'

const SETTINGS: Settings = { id: 's1', deleted: false, ...DEFAULT_SETTINGS }
const ACCOUNT: Account = { id: 'acc1', deleted: false, name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0 }
const CATEGORIES: Category[] = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat${i}`, deleted: false }))
const cat = (name: string) => CATEGORIES.find((c) => c.name === name)!
const RATES: FxRate[] = [
  { date: TODAY, currency: 'UAH', uah_per_unit: 1 },
  { date: TODAY, currency: 'USD', uah_per_unit: 41.2 },
  { date: TODAY, currency: 'EUR', uah_per_unit: 44.9 },
]

class MemStore implements BotStore {
  seen = new Set<number>()
  settingsRow: Settings | null = SETTINGS
  accountRows: Account[] = [ACCOUNT]
  categoryRows: Category[] = CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] }))
  goalRows: Goal[] = []
  moveRows: GoalMove[] = []
  limitRows: Limit[] = []
  txRows: Transaction[] = []
  rateRows: FxRate[] = RATES

  async seenUpdate(id: number) {
    if (this.seen.has(id)) return true
    this.seen.add(id)
    return false
  }
  async settings() { return this.settingsRow }
  async categories() { return this.categoryRows.filter((c) => !c.deleted) }
  async accounts() { return this.accountRows.filter((a) => !a.deleted) }
  async goals() { return this.goalRows.filter((g) => !g.deleted) }
  async goalMoves() { return this.moveRows.filter((m) => !m.deleted) }
  async limits() { return this.limitRows.filter((l) => !l.deleted) }
  async transactions() { return this.txRows.filter((t) => !t.deleted) }
  async rates() { return this.rateRows }
  async insertTx(t: Transaction) { this.txRows.push(t) }
  async updateTx(id: string, patch: Partial<Transaction>) {
    this.txRows = this.txRows.map((t) => (t.id === id ? { ...t, ...patch } : t))
  }
  async insertGoalMove(m: GoalMove) { this.moveRows.push(m) }
  async updateCategory(id: string, patch: Partial<Category>) {
    this.categoryRows = this.categoryRows.map((c) => (c.id === id ? { ...c, ...patch } : c))
  }
}

function seedTx(over: Partial<Transaction>): Transaction {
  return {
    id: `seed-${Math.random()}`, deleted: false, kind: 'expense', amount: 0, currency: 'USD', rate_usd: 1,
    amount_usd: 0, rate_pending: false, account_id: 'acc1', to_account_id: null, to_amount: null, to_currency: null,
    category_id: null, date: TODAY, note: '', source: 'app', created_at: '2026-10-01T00:00:00.000Z', ...over,
  }
}

let n = 0
const uuid = () => `id-${++n}`
let updateSeq = 1000
const msg = (text: string, chatId = OWNER, updateId = ++updateSeq) => ({
  update_id: updateId,
  message: { message_id: 5, chat: { id: chatId }, text },
})
const cb = (data: string, updateId = ++updateSeq) => ({
  update_id: updateId,
  callback_query: { id: 'cbq1', data, message: { message_id: 9, chat: { id: OWNER } } },
})
const run = (store: BotStore, update: unknown) => handleUpdate(update, OWNER, store, NOW, uuid)
const textOf = (r: BotReply[]) => r.map((x) => String(x.payload.text ?? '')).join('\n')
const buttons = (r: BotReply[]) =>
  r.flatMap((x) =>
    ((x.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)
      ?.inline_keyboard ?? []).flat(),
  )

describe('handleUpdate', () => {
  it('ignores a foreign chat and writes nothing', async () => {
    const s = new MemStore()
    expect(await run(s, msg('кофе 80', 123))).toEqual([])
    expect(s.txRows).toHaveLength(0)
    expect(s.seen.size).toBe(0)
  })

  it('processes the same update_id only once', async () => {
    const s = new MemStore()
    const u = msg('кофе 80', OWNER, 4242)
    expect((await run(s, u)).length).toBeGreaterThan(0)
    expect(await run(s, u)).toEqual([])
    expect(s.txRows).toHaveLength(1)
  })

  it('asks to open the app when there are no settings', async () => {
    const s = new MemStore()
    s.settingsRow = null
    const r = await run(s, msg('кофе 80'))
    expect(textOf(r)).toContain('Сначала открой приложение')
    expect(s.txRows).toHaveLength(0)
  })

  it('saves "кофе 80" as a bot expense and replies with the category line and undo button', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    expect(s.txRows).toHaveLength(1)
    const t = s.txRows[0]
    expect(t).toMatchObject({
      kind: 'expense', amount: 80, currency: 'UAH', source: 'bot', amount_usd: 1.94, category_id: cat('Кафе и рестораны').id,
      account_id: 'acc1', date: TODAY, rate_pending: false, deleted: false,
    })
    expect(t.created_at).toBe(NOW.toISOString())
    expect(r[0].method).toBe('sendMessage')
    expect(r[0].payload.chat_id).toBe(OWNER)
    expect(textOf(r)).toContain('☕ Кафе и рестораны · 80 ₴ ($1.94)')
    expect(buttons(r).map((b) => b.callback_data)).toContain(`u:${t.id}`)
  })

  it('converts foreign currency: "такси 15 eur"', async () => {
    const s = new MemStore()
    const r = await run(s, msg('такси 15 eur'))
    expect(s.txRows[0]).toMatchObject({ currency: 'EUR', amount_usd: 16.35 })
    expect(textOf(r)).toContain('Транспорт и такси · 15 € ($16.35)')
  })

  it('does not repeat USD for USD-only amounts and prefixes income with +', async () => {
    const s = new MemStore()
    const r = await run(s, msg('+3000 usd'))
    expect(s.txRows[0]).toMatchObject({ kind: 'income', amount_usd: 3000, category_id: cat('Зарплата').id })
    expect(textOf(r)).toContain('💰 Зарплата · +$3 000')
    expect(textOf(r)).not.toContain('($3 000)')
  })

  it('marks the rate pending when only an earlier rate is known, and 0 when none', async () => {
    const s = new MemStore()
    s.rateRows = RATES.map((r) => ({ ...r, date: '2026-10-19' }))
    await run(s, msg('кофе 80'))
    expect(s.txRows[0].rate_pending).toBe(true)
    expect(s.txRows[0].amount_usd).toBe(1.94)
    const s2 = new MemStore()
    s2.rateRows = []
    await run(s2, msg('кофе 80'))
    expect(s2.txRows[0]).toMatchObject({ rate_usd: 0, amount_usd: 0, rate_pending: true })
  })

  it('saves an unmatched expense to Прочее with category buttons', async () => {
    const s = new MemStore()
    const r = await run(s, msg('непонятное 50'))
    const t = s.txRows[0]
    expect(t.category_id).toBe(cat('Прочее').id)
    const cbs = buttons(r).map((b) => b.callback_data)
    expect(cbs).toContain(`c:${t.id}:${cat('Здоровье').sort}`)
    expect(cbs).toContain(`u:${t.id}`)
    expect(cbs).not.toContain(`c:${t.id}:${cat('Прочее').sort}`)
    expect(cbs).not.toContain(`c:${t.id}:${cat('Зарплата').sort}`)
  })

  it('callback c: recategorises, teaches the keyword and answers the query', async () => {
    const s = new MemStore()
    await run(s, msg('непонятное 50'))
    const t = s.txRows[0]
    const r = await run(s, cb(`c:${t.id}:${cat('Здоровье').sort}`))
    expect(s.txRows[0].category_id).toBe(cat('Здоровье').id)
    expect(s.categoryRows.find((c) => c.name === 'Здоровье')!.keywords).toContain('непонятное')
    expect(r.map((x) => x.method)).toEqual(['answerCallbackQuery', 'editMessageText'])
    expect(r[0].payload.callback_query_id).toBe('cbq1')
    expect(r[1].payload).toMatchObject({ chat_id: OWNER, message_id: 9 })
    expect(textOf(r)).toContain('💊 Здоровье · 50 ₴')
    // second pick must not duplicate the keyword
    await run(s, cb(`c:${t.id}:${cat('Здоровье').sort}`))
    expect(s.categoryRows.find((c) => c.name === 'Здоровье')!.keywords.filter((k) => k === 'непонятное')).toHaveLength(1)
  })

  it('callback u: soft-deletes the transaction and edits the message', async () => {
    const s = new MemStore()
    await run(s, msg('кофе 80'))
    const t = s.txRows[0]
    const r = await run(s, cb(`u:${t.id}`))
    expect(s.txRows[0].deleted).toBe(true)
    expect(r.map((x) => x.method)).toEqual(['answerCallbackQuery', 'editMessageText'])
    expect(String(r[1].payload.text)).toMatch(/^Удалено: /)
  })

  it('warns when a limit crosses 80%', async () => {
    const s = new MemStore()
    const kafe = cat('Кафе и рестораны')
    s.limitRows = [{ id: 'l1', deleted: false, category_id: kafe.id, monthly_usd: 100 }]
    s.txRows = [seedTx({ category_id: kafe.id, amount: 79, amount_usd: 79, date: '2026-10-05' })]
    const r = await run(s, msg('кофе 80'))
    expect(textOf(r)).toContain('⚠️')
    expect(textOf(r)).toContain('Кафе и рестораны за месяц: $80.94 из $100')
  })

  it('marks 🔴 when a limit is exceeded and no emoji when nothing is crossed', async () => {
    const s = new MemStore()
    const kafe = cat('Кафе и рестораны')
    s.limitRows = [{ id: 'l1', deleted: false, category_id: kafe.id, monthly_usd: 100 }]
    s.txRows = [seedTx({ category_id: kafe.id, amount: 99, amount_usd: 99, date: '2026-10-05' })]
    expect(textOf(await run(s, msg('кофе 80')))).toContain('🔴 Кафе и рестораны за месяц: $100.94 из $100')
    const s2 = new MemStore()
    s2.limitRows = [{ id: 'l1', deleted: false, category_id: kafe.id, monthly_usd: 100 }]
    const t2 = textOf(await run(s2, msg('кофе 80')))
    expect(t2).toContain('Кафе и рестораны за месяц: $1.94 из $100')
    expect(t2).not.toContain('⚠️')
    expect(t2).not.toContain('🔴')
  })

  it('undo deletes the latest bot transaction only', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ id: 'appTx', source: 'app', created_at: '2026-10-21T09:59:00.000Z' })]
    await run(s, msg('кофе 80'))
    const r = await run(s, msg('отмена'))
    expect(textOf(r)).toMatch(/^Удалено:/)
    expect(s.txRows.find((t) => t.source === 'bot')!.deleted).toBe(true)
    expect(s.txRows.find((t) => t.id === 'appTx')!.deleted).toBe(false)
    expect(textOf(await run(s, msg('отмена')))).toContain('Нечего отменять')
  })

  it('adds money to a goal by name prefix, converted to USD', async () => {
    const s = new MemStore()
    s.goalRows = [{ id: 'g1', deleted: false, name: 'Машина', target_usd: 5000, deadline: null, archived: false }]
    const r = await run(s, msg('цель маш 500'))
    expect(s.moveRows).toHaveLength(1)
    expect(s.moveRows[0]).toMatchObject({ goal_id: 'g1', amount_usd: 12.14, date: TODAY, deleted: false })
    expect(textOf(r)).toContain('Машина')
    expect(textOf(r)).toContain('$12.14')
  })

  it('reports an unknown goal with the list of goals', async () => {
    const s = new MemStore()
    s.goalRows = [{ id: 'g1', deleted: false, name: 'Машина', target_usd: 5000, deadline: null, archived: false }]
    const r = await run(s, msg('цель дом 100'))
    expect(s.moveRows).toHaveLength(0)
    expect(textOf(r)).toContain('Цель «дом» не найдена')
    expect(textOf(r)).toContain('Твои цели: Машина')
  })

  it('says there are no goals when none exist', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('цель дом 100')))).toContain('Целей пока нет — создай в приложении')
  })

  it('refuses a goal amount in a currency without a rate', async () => {
    const s = new MemStore()
    s.goalRows = [{ id: 'g1', deleted: false, name: 'Машина', target_usd: 5000, deadline: null, archived: false }]
    const r = await run(s, msg('цель машина 100 лей'))
    expect(s.moveRows).toHaveLength(0)
    expect(textOf(r)).toContain('Нет курса для этой валюты')
  })

  it('/left shows allowance per month when the contract date is set', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-12-21' }
    s.txRows = [seedTx({ kind: 'income', amount: 3000, amount_usd: 3000, currency: 'USD', category_id: cat('Зарплата').id })]
    s.goalRows = [{ id: 'g1', deleted: false, name: 'Машина', target_usd: 5000, deadline: null, archived: false }]
    s.moveRows = [{ id: 'm1', deleted: false, goal_id: 'g1', amount_usd: 1000, date: TODAY, note: '' }]
    const r = await run(s, msg('остаток'))
    expect(textOf(r)).toContain('в месяц')
    expect(textOf(r)).toContain('$2 000') // 3000 balance - 1000 reserved
  })

  it('/left asks to set the contract date when it is missing', async () => {
    const s = new MemStore()
    const t = textOf(await run(s, msg('/left')))
    expect(t).toContain('дату следующего контракта')
    expect(t).not.toContain('в месяц')
  })

  it('/left in contract status shows contract stats', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, status: 'contract', contract_start_date: '2026-10-01', contract_end_date: '2027-04-01' }
    s.txRows = [seedTx({ kind: 'income', amount: 3000, amount_usd: 3000, currency: 'USD', date: '2026-10-10' })]
    const t = textOf(await run(s, msg('остаток')))
    expect(t).toContain('Заработано')
    expect(t).toContain('$3 000')
  })

  it('/month lists the month total and categories by amount, descending', async () => {
    const s = new MemStore()
    s.txRows = [
      seedTx({ category_id: cat('Кафе и рестораны').id, amount_usd: 10, amount: 10 }),
      seedTx({ category_id: cat('Продукты').id, amount_usd: 30, amount: 30, date: '2026-10-03' }),
      seedTx({ category_id: cat('Продукты').id, amount_usd: 500, amount: 500, date: '2026-09-03' }),
    ]
    const t = textOf(await run(s, msg('/month')))
    expect(t).toContain('$40')
    expect(t.indexOf('Продукты')).toBeGreaterThan(-1)
    expect(t.indexOf('Продукты')).toBeLessThan(t.indexOf('Кафе и рестораны'))
    expect(t).toContain('$30')
    expect(t).toContain('$10')
  })

  it('/today lists today expenses and their USD total', async () => {
    const s = new MemStore()
    s.txRows = [
      seedTx({ category_id: cat('Кафе и рестораны').id, amount: 80, currency: 'UAH', amount_usd: 1.94 }),
      seedTx({ category_id: cat('Продукты').id, amount: 10, currency: 'USD', amount_usd: 10 }),
      seedTx({ category_id: cat('Продукты').id, amount: 99, currency: 'USD', amount_usd: 99, date: '2026-10-20' }),
    ]
    const t = textOf(await run(s, msg('сегодня')))
    expect(t).toContain('Кафе и рестораны · 80 ₴ ($1.94)')
    expect(t).toContain('Продукты · $10')
    expect(t).not.toContain('$99')
    expect(t).toContain('$11.94')
  })

  it('/today with no expenses says so', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('/today')))).toContain('Сегодня трат нет')
  })

  it('replies with help examples when no amount is given', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе'))
    expect(s.txRows).toHaveLength(0)
    expect(textOf(r)).toContain('кофе 80')
    expect(textOf(r)).toContain('такси 15 eur')
  })

  it('/start and /help show the help', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('/start')))).toContain('кофе 80')
    expect(textOf(await run(s, msg('/help')))).toContain('кофе 80')
  })

  it('ignores updates without text', async () => {
    const s = new MemStore()
    const u = { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: [] } }
    expect(await run(s, u)).toEqual([])
  })
})
