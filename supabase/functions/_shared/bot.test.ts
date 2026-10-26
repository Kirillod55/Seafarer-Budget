import { describe, expect, it } from 'vitest'
import { handleUpdate, restorePatch } from './bot.ts'
import { ACCOUNT, buttons, cat, cb, MemStore, msg, NOW, OWNER, run, SETTINGS, seedTx, textOf, TODAY, uuid } from './bot/testkit.ts'

const short = (id: string) => id.slice(0, 8)
const goal = { id: 'g1', deleted: false, deleted_at: null, deleted_batch: null, name: 'Машина', target_usd: 5000, deadline: null, archived: false }

describe('handleUpdate (1.0 behaviour kept)', () => {
  it('ignores a foreign chat and writes nothing', async () => {
    const s = new MemStore()
    expect(await run(s, msg('кофе 80', 123))).toEqual([])
    expect(s.txRows).toHaveLength(0)
    expect(s.seen.size).toBe(0)
  })

  it('a plain number as chats is the 1.0 owner-only form', async () => {
    const s = new MemStore()
    await handleUpdate(msg('кофе 80'), OWNER, s, NOW, uuid)
    expect(s.txRows[0].author).toBe('owner')
    expect(await handleUpdate(msg('кофе 80', 888), OWNER, s, NOW, uuid)).toEqual([])
  })

  it('processes the same update_id only once', async () => {
    const s = new MemStore()
    const u = msg('кофе 80')
    expect((await run(s, u)).length).toBeGreaterThan(0)
    expect(await run(s, u)).toEqual([])
    expect(s.txRows).toHaveLength(1)
  })

  it('asks to open the app when there are no settings', async () => {
    const s = new MemStore()
    s.settingsRow = null
    expect(textOf(await run(s, msg('кофе 80')))).toContain('Сначала открой приложение')
    expect(s.txRows).toHaveLength(0)
  })

  it('saves "кофе 80" as a bot expense with Категория and Отменить', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    const t = s.txRows[0]
    expect(t).toMatchObject({
      kind: 'expense', amount: 80, currency: 'UAH', source: 'bot', amount_usd: 1.94, category_id: cat('Кафе и рестораны').id,
      account_id: 'acc1', date: TODAY, rate_pending: false, deleted: false, author: 'owner', created_at: NOW.toISOString(),
    })
    expect(r[0].payload.chat_id).toBe(OWNER)
    expect(textOf(r)).toContain('☕ Кафе и рестораны · ₴80 ($1.94)')
    expect(buttons(r).map((b) => b.callback_data)).toEqual([`c:${t.id}`, `u:${t.id}`])
  })

  it('converts foreign currency and marks a pending rate', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('такси 15 eur')))).toContain('Транспорт и такси · €15 ($16.35)')
    const s2 = new MemStore()
    s2.rateRows = []
    await run(s2, msg('кофе 80'))
    expect(s2.txRows[0]).toMatchObject({ rate_usd: 0, amount_usd: 0, rate_pending: true })
  })

  it('income: +3000 usd', async () => {
    const s = new MemStore()
    const r = await run(s, msg('+3000 usd'))
    expect(s.txRows[0]).toMatchObject({ kind: 'income', amount_usd: 3000, category_id: cat('Зарплата').id })
    expect(textOf(r)).toContain('💰 Зарплата · +$3,000')
  })

  it('an unmatched expense goes to Прочее with the category picker (ids, not sort)', async () => {
    const s = new MemStore()
    const r = await run(s, msg('непонятное 50'))
    const t = s.txRows[0]
    expect(t.category_id).toBe(cat('Прочее').id)
    const cbs = buttons(r).map((b) => b.callback_data)
    expect(cbs).toContain(`c:${t.id}:${short(cat('Здоровье').id)}`)
    expect(cbs).not.toContain(`c:${t.id}:${short(cat('Прочее').id)}`)
    expect(cbs).not.toContain(`c:${t.id}:${short(cat('Зарплата').id)}`)
  })

  it('callback c: recategorises, teaches the keyword once, stopwords skipped', async () => {
    const s = new MemStore()
    await run(s, msg('за квартиру 5000'))
    const t = s.txRows[0]
    const health = cat('Здоровье')
    const r = await run(s, cb(`c:${t.id}:${short(health.id)}`))
    expect(s.txRows[0].category_id).toBe(health.id)
    expect(r.map((x) => x.method)).toEqual(['answerCallbackQuery', 'editMessageText'])
    expect(textOf(r)).toContain('Запомнил: «квартиру» → Здоровье')
    await run(s, cb(`c:${t.id}:${short(health.id)}`))
    expect(s.categoryRows.find((c) => c.id === health.id)!.keywords.filter((k) => k === 'квартиру')).toHaveLength(1)
    expect(s.categoryRows.find((c) => c.id === health.id)!.keywords).not.toContain('за')
  })

  it('«Категория» opens the picker in place', async () => {
    const s = new MemStore()
    await run(s, msg('кофе 80'))
    const t = s.txRows[0]
    const r = await run(s, cb(`c:${t.id}`, { reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: `u:${t.id}` }]] } }))
    expect(r[1].method).toBe('editMessageText')
    expect(buttons(r).map((b) => b.callback_data)).toContain(`c:${t.id}:${short(cat('Продукты').id)}`)
  })

  it('callback u: deletes the record and edits the message', async () => {
    const s = new MemStore()
    await run(s, msg('кофе 80'))
    const r = await run(s, cb(`u:${s.txRows[0].id}`))
    expect(s.txRows[0].deleted).toBe(true)
    expect(String(r[1].payload.text)).toMatch(/^Удалено: /)
  })

  it('limits: ⚠️ at 80%, 🔴 over, nothing otherwise', async () => {
    const kafe = cat('Кафе и рестораны')
    const lim = { id: 'l1', deleted: false, deleted_at: null, deleted_batch: null, category_id: kafe.id, monthly_usd: 100 }
    const s = new MemStore()
    s.limitRows = [lim]
    s.txRows = [seedTx({ category_id: kafe.id, amount: 79, amount_usd: 79, date: '2026-10-05' })]
    expect(textOf(await run(s, msg('кофе 80')))).toContain('⚠️ Кафе и рестораны за месяц: $80.94 из $100')
    const s2 = new MemStore()
    s2.limitRows = [lim]
    s2.txRows = [seedTx({ category_id: kafe.id, amount: 99, amount_usd: 99, date: '2026-10-05' })]
    expect(textOf(await run(s2, msg('кофе 80')))).toContain('🔴 Кафе и рестораны за месяц: $100.94 из $100')
  })

  it('undo deletes the latest bot record of the writer only', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ id: 'appTx', source: 'app', created_at: '2026-10-21T09:59:00.000Z' })]
    await run(s, msg('кофе 80'))
    expect(textOf(await run(s, msg('отмена')))).toMatch(/^Удалено:/)
    expect(s.txRows.find((t) => t.source === 'bot')!.deleted).toBe(true)
    expect(s.txRows.find((t) => t.id === 'appTx')!.deleted).toBe(false)
    expect(textOf(await run(s, msg('отмена')))).toContain('Нечего отменять')
  })

  it('goals: add by name prefix with «Отменить»; /undo after the goal undoes the move, not the expense', async () => {
    const s = new MemStore()
    s.goalRows = [goal]
    await run(s, msg('кофе 80'))
    const r = await run(s, msg('цель маш 500'))
    expect(s.moveRows[0]).toMatchObject({ goal_id: 'g1', amount_usd: 12.14, author: 'owner', source: 'bot' })
    expect(buttons(r).map((b) => b.callback_data)).toEqual([`ug:${s.moveRows[0].id}`])
    s.moveRows[0].created_at = '2026-10-21T10:00:01.000Z'
    await run(s, msg('/undo'))
    expect(s.moveRows[0].deleted).toBe(true)
    expect(s.txRows[0].deleted).toBe(false)
  })

  it('goals: unknown, none, no rate', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('цель дом 100')))).toContain('Целей пока нет — создай в приложении')
    s.goalRows = [goal]
    expect(textOf(await run(s, msg('цель дом 100')))).toContain('Твои цели: Машина')
    s.rateRows = s.rateRows.filter((r) => r.currency !== 'MDL')
    expect(textOf(await run(s, msg('цель машина 100 лей')))).toContain('Нет курса для этой валюты')
  })

  it('/month in Russian, categories descending', async () => {
    const s = new MemStore()
    s.txRows = [
      seedTx({ category_id: cat('Кафе и рестораны').id, amount_usd: 10, amount: 10 }),
      seedTx({ category_id: cat('Продукты').id, amount_usd: 30, amount: 30, date: '2026-10-03' }),
      seedTx({ category_id: cat('Продукты').id, amount_usd: 500, amount: 500, date: '2026-09-03' }),
    ]
    const t = textOf(await run(s, msg('/month')))
    expect(t).toContain('Итого за октябрь: $40')
    expect(t).toContain('Сентябрь: $500')
    expect(t.indexOf('Продукты')).toBeLessThan(t.indexOf('Кафе и рестораны'))
  })

  it('/today lists today expenses and their total; none says so', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('/today')))).toContain('Сегодня трат нет')
    s.txRows = [
      seedTx({ category_id: cat('Кафе и рестораны').id, amount: 80, currency: 'UAH', amount_usd: 1.94 }),
      seedTx({ category_id: cat('Продукты').id, amount: 10, currency: 'USD', amount_usd: 10 }),
      seedTx({ category_id: cat('Продукты').id, amount: 99, currency: 'USD', amount_usd: 99, date: '2026-10-20' }),
    ]
    const t = textOf(await run(s, msg('сегодня')))
    expect(t).toContain('Кафе и рестораны · ₴80 ($1.94)')
    expect(t).not.toContain('$99')
    expect(t).toContain('$11.94')
  })

  it('no amount: a short hint for record-like text, the help otherwise', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('кофе')))).toBe('Не вижу суммы. Например: кофе 80\nВся инструкция — /help')
    expect(s.txRows).toHaveLength(0)
  })

  it('ignores updates without text', async () => {
    const s = new MemStore()
    expect(await run(s, { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: [] } })).toEqual([])
  })
})

describe('alive filters', () => {
  it('undo never picks a row from the undo bin', async () => {
    const s = new MemStore()
    s.txRows = [
      seedTx({ id: 'old', source: 'bot', created_at: '2026-10-21T09:00:00.000Z' }),
      seedTx({ id: 'binned', source: 'bot', created_at: '2026-10-21T09:30:00.000Z', deleted_at: '2026-10-19T09:40:00.000Z', deleted_batch: 'b1' }),
    ]
    await run(s, msg('/undo'))
    expect(s.txRows.find((t) => t.id === 'binned')!.deleted).toBe(false)
    expect(s.txRows.find((t) => t.id === 'old')!.deleted).toBe(true)
  })

  it('restorePatch sends base_rev = rev so set_rev() lets the row out of the bin', () => {
    expect(restorePatch({ rev: 41 })).toEqual({ deleted_at: null, deleted_batch: null, base_rev: 41 })
  })

  it('/today leaves binned rows out', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ amount: 5, amount_usd: 5, deleted_at: '2026-10-21T09:40:00.000Z', deleted_batch: 'b1' })]
    expect(textOf(await run(s, msg('/today')))).toContain('Сегодня трат нет')
  })
})

describe('/left and «Сегодня осталось» (spec §2, §5)', () => {
  const income = (usd: number) => seedTx({ kind: 'income', amount: usd, amount_usd: usd, date: '2026-10-01', category_id: cat('Зарплата').id })

  it('ok: today budget, balance, landing, reserve', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-10-31', reserve_usd: 1000 }
    s.txRows = [income(3200)]
    s.goalRows = [goal]
    s.moveRows = [{ id: 'm1', deleted: false, goal_id: 'g1', amount_usd: 1100, date: TODAY, note: '', author: 'owner', source: 'app', created_at: '2026-10-01T12:00:00.000Z' }]
    // free = 3200 - 1100 - 1000 = 1100 over 11 days = 100/day
    expect(textOf(await run(s, msg('/left')))).toBe('Сегодня можно ещё $100 из $100 · баланс $3,200 · посадка 31 октября (11 дн) · запас $1,000')
    const r = await run(s, msg('кофе 412'))
    expect(textOf(r)).toContain('Сегодня осталось $90 из $100')
  })

  it('archived and binned goals reserve nothing; archived accounts do not count', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-10-31' }
    s.accountRows = [ACCOUNT, { ...ACCOUNT, id: 'old', name: 'Старый', is_default: false, archived: true, sort: 1 }]
    s.txRows = [income(1100), { ...income(500), account_id: 'old' }]
    s.goalRows = [{ ...goal, archived: true }, { ...goal, id: 'g2', deleted_at: '2026-10-21T09:00:00.000Z', deleted_batch: 'b' }]
    s.moveRows = [
      { id: 'm1', deleted: false, goal_id: 'g1', amount_usd: 100, date: TODAY, note: '', author: 'owner', source: 'app', created_at: '2026-10-01T12:00:00.000Z' },
      { id: 'm2', deleted: false, goal_id: 'g2', amount_usd: 100, date: TODAY, note: '', author: 'owner', source: 'app', created_at: '2026-10-01T12:00:00.000Z' },
    ]
    expect(textOf(await run(s, msg('остаток')))).toContain('из $100 · баланс $1,100')
  })

  it('overspent, reserve, no date, at sea', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-10-31' }
    s.txRows = [income(1100), seedTx({ amount: 150, amount_usd: 150 })]
    expect(textOf(await run(s, msg('/left')))).toContain('Сегодня перерасход $50 (бюджет $100)')
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-10-31', reserve_usd: 5000 }
    expect(textOf(await run(s, msg('/left')))).toContain('Ты тратишь запас к посадке')
    s.settingsRow = { ...SETTINGS }
    expect(textOf(await run(s, msg('/left')))).toContain('Укажи дату посадки')
    s.settingsRow = { ...SETTINGS, next_contract_date: '2026-10-01' }
    expect(textOf(await run(s, msg('/left')))).toContain('Вернулся?')
  })
})
