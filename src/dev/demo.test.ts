import { afterEach, describe, expect, it } from 'vitest'
import { alive } from '@shared/alive.ts'
import { addDays, monthOf } from '@shared/dates.ts'
import { createDb } from '../db/local.ts'
import { isDemo, seedDemo } from './demo.ts'

const TODAY = '2026-10-25'

afterEach(() => {
  history.replaceState(null, '', location.pathname)
})

describe('isDemo', () => {
  it('is on only with #demo (dev build)', () => {
    expect(isDemo()).toBe(false)
    location.hash = '#demo'
    expect(isDemo()).toBe(true)
  })
})

describe('seedDemo', () => {
  it('fills three months of records with Masha, an archived one and one in the bin', async () => {
    const db = createDb('demo-seed-1')
    await seedDemo(db, TODAY)

    const txs = await db.transactions.toArray()
    const expenses = txs.filter((t) => t.kind === 'expense')
    expect(new Set(expenses.map((t) => monthOf(t.date)))).toEqual(new Set(['2026-08', '2026-09', '2026-10']))
    expect(expenses.some((t) => t.date === TODAY && alive(t))).toBe(true)
    expect(expenses.every((t) => t.date <= TODAY)).toBe(true)
    expect(expenses.filter((t) => t.author === 'partner' && alive(t)).length).toBeGreaterThan(3)
    expect(expenses.filter((t) => t.archived && alive(t))).toHaveLength(1)
    expect(txs.filter((t) => t.deleted_at !== null && t.deleted_batch !== null)).toHaveLength(1)

    // every record is complete (1.1 fields, a known category and account, a USD amount)
    const categories = new Set((await db.categories.toArray()).map((c) => c.id))
    const accounts = new Set((await db.accounts.toArray()).map((a) => a.id))
    for (const t of txs) {
      expect(t.author === 'owner' || t.author === 'partner').toBe(true)
      expect(typeof t.archived).toBe('boolean')
      expect(accounts.has(t.account_id)).toBe(true)
      if (t.kind === 'expense' || t.kind === 'income') expect(categories.has(t.category_id!)).toBe(true)
      expect(t.amount_usd).toBeGreaterThan(0)
    }
  })

  it('sets up settings, goals and limits', async () => {
    const db = createDb('demo-seed-2')
    await seedDemo(db, TODAY)

    const [settings] = await db.settings.toArray()
    expect(settings).toMatchObject({ partner_name: 'Маша', reserve_usd: 1000, next_contract_date: addDays(TODAY, 59) })

    const goals = await db.goals.toArray()
    expect(goals).toHaveLength(2)
    expect(goals.filter((g) => g.archived)).toHaveLength(1)
    expect(goals.some((g) => g.target_usd === 1234567.89)).toBe(true)
    expect((await db.goal_moves.toArray()).length).toBeGreaterThan(0)
    expect(await db.limits.count()).toBe(2)

    // long values for the 375 px check (Review Focus 2)
    const txs = await db.transactions.toArray()
    expect(txs.some((t) => t.note.length === 80)).toBe(true)
  })

  it('does nothing on a database that already has data', async () => {
    const db = createDb('demo-seed-3')
    await seedDemo(db, TODAY)
    const count = await db.transactions.count()
    await seedDemo(db, TODAY)
    expect(await db.transactions.count()).toBe(count)
  })
})
