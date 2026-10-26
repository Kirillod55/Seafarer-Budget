import { describe, expect, it } from 'vitest'
import { asMessage, buttons, cat, cb, MemStore, msg, OWNER, PARTNER, run, SETTINGS, seedTx, textOf, TODAY } from './testkit.ts'
import type { Account } from '../types.ts'

const multi = (s: MemStore) => {
  s.settingsRow = { ...SETTINGS, accounts_mode: 'multi', partner_name: 'Маша' }
  const acc = (id: string, name: string, sort: number): Account => ({ id, deleted: false, name, aliases: [], is_default: sort === 0, archived: false, sort })
  s.accountRows = [acc('acc1', 'Основной', 0), acc('acc2-cash-0000', 'Наличные', 1), acc('acc3-pro-00000', 'ProCreditBank', 2)]
}

describe('two chats and the author (spec §9)', () => {
  it('a partner record gets author partner, updates partner_seen_at and tells Kirill', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, partner_name: 'Маша' }
    const r = await run(s, msg('кофе 80', PARTNER))
    expect(s.txRows[0].author).toBe('partner')
    expect(s.settingsRow!.partner_seen_at).toBe('2026-10-21T10:00:00.000Z')
    expect(r[0].payload.chat_id).toBe(PARTNER)
    expect(r[1].payload).toMatchObject({ chat_id: OWNER, text: 'Маша: Кафе и рестораны · $1.94' })
  })

  it('an owner record sends no notice', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    expect(r).toHaveLength(1)
  })

  it('her /undo leaves Kirill’s records; buttons under the other person’s record do nothing', async () => {
    const s = new MemStore()
    await run(s, msg('кофе 80'))
    expect(textOf(await run(s, msg('/undo', PARTNER)))).toContain('Нечего отменять')
    expect(s.txRows[0].deleted).toBe(false)
    const r = await run(s, cb(`u:${s.txRows[0].id}`, {}, PARTNER))
    expect(textOf(r)).toBe('Это не твоя запись')
    expect(s.txRows[0].deleted).toBe(false)
  })

  it('her undo is reported to Kirill', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, partner_name: 'Маша' }
    await run(s, msg('кофе 80', PARTNER))
    const r = await run(s, msg('/undo', PARTNER))
    expect(r.find((x) => x.payload.chat_id === OWNER)?.payload.text).toBe('Маша отменила: ☕ Кафе и рестораны · ₴80 ($1.94)')
  })
})

describe('record replies (spec §5)', () => {
  it('multi mode: account in the reply, buttons of the other accounts; a button moves the record', async () => {
    const s = new MemStore()
    multi(s)
    const r = await run(s, msg('кофе 80'))
    const t = s.txRows[0]
    expect(textOf(r)).toContain('☕ Кафе и рестораны · ₴80 ($1.94) · Основной')
    expect(buttons(r).map((b) => b.text)).toEqual(['🏷 Категория', 'Наличные', 'ProCreditBank', 'Отменить'])
    const moved = await run(s, cb(`a:${t.id}:acc2-cas`, asMessage(r[0])))
    expect(s.txRows[0].account_id).toBe('acc2-cash-0000')
    expect(textOf(moved)).toContain('· Наличные')
    expect(buttons(moved).map((b) => b.text)).toContain('Отменить')
  })

  it('single mode: no account, no account buttons', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    expect(textOf(r)).not.toContain('Основной')
    expect(buttons(r)).toHaveLength(2)
  })

  it('the date word and the guessed currency are shown', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('вчера кофе 80')))).toContain('· вчера')
    expect(textOf(await run(s, msg('19.10 кофе 80')))).toContain('· позавчера')
    expect(textOf(await run(s, msg('кофе 80 01.10.26')))).toContain('· 1 октября')
    expect(textOf(await run(s, msg('кофе 80 grн')))).toContain('«grн» понял как гривны')
    expect(textOf(await run(s, msg('25.10 кофе 80')))).toBe('Не записываю в будущее — проверь дату')
  })

  it('several records: «Записал 3», a row per record, «Отменить все» removes them all', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80\nтакси 150\nатб 420'))
    expect(s.txRows).toHaveLength(3)
    expect(textOf(r)).toContain('Записал 3:')
    expect(textOf(r)).toContain('2) 🚕 Транспорт и такси · ₴150')
    expect(buttons(r).map((b) => b.text)).toEqual(['✏️ 1 · Кафе и рестораны', '✕', '✏️ 2 · Транспорт и такси', '✕', '✏️ 3 · Продукты', '✕', 'Отменить все'])
    await run(s, cb('uall', asMessage(r[0])))
    expect(s.txRows.every((t) => t.deleted)).toBe(true)
  })

  it('a line without an amount writes nothing', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('кофе 80\nтакси')))).toBe('Строка 2 без суммы: «такси»')
    expect(s.txRows).toHaveLength(0)
  })

  it('a word without an amount: question first, then the choice saves all', async () => {
    const s = new MemStore()
    const q = await run(s, msg('кофе 50 сигареты 30 чек'))
    expect(s.txRows).toHaveLength(0)
    expect(textOf(q)).toContain('Не понял, к какой трате «чек»')
    expect(q[0].payload.reply_to_message_id).toBe(5)
    const original = { message_id: 5, text: 'кофе 50 сигареты 30 чек' }
    const r = await run(s, cb('ow:1', { ...asMessage(q[0]), reply_to_message: original }))
    expect(s.txRows.map((t) => t.note)).toEqual(['кофе чек', 'сигареты'])
    expect(textOf(r)).toContain('Записал 2')
    const s2 = new MemStore()
    await run(s2, cb('ow:x', { ...asMessage(q[0]), reply_to_message: original }))
    expect(s2.txRows).toHaveLength(0)
  })

  it('quantity: «2 кофе по 50»', async () => {
    const s = new MemStore()
    await run(s, msg('2 кофе по 50'))
    expect(s.txRows[0]).toMatchObject({ amount: 100, note: 'Кофе ×2 по ₴50' })
  })
})

describe('edits by reply (spec §5, group 6)', () => {
  const reply = (text: string, bot: ReturnType<typeof asMessage>, chat = OWNER) => msg(text, chat, { reply_to_message: bot })

  it('«90» changes the amount, «90 eur» the currency too, and the message is updated', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    const e = await run(s, reply('90', asMessage(r[0], 41)))
    expect(s.txRows[0]).toMatchObject({ amount: 90, amount_usd: 2.18 })
    expect(e[0]).toMatchObject({ method: 'editMessageText', payload: { message_id: 41 } })
    expect(textOf(e)).toContain('Исправил: ₴80 ($1.94) → ₴90 ($2.18)')
    await run(s, reply('90 eur', asMessage(r[0])))
    expect(s.txRows[0]).toMatchObject({ amount: 90, currency: 'EUR' })
  })

  it('words change the note and the category; a category name changes only the category', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    await run(s, reply('аптека', asMessage(r[0])))
    expect(s.txRows[0]).toMatchObject({ note: 'аптека', category_id: cat('Здоровье').id })
    await run(s, reply('кафе', asMessage(r[0])))
    expect(s.txRows[0]).toMatchObject({ note: 'аптека', category_id: cat('Кафе и рестораны').id })
  })

  it('«вчера», «удали» (with Вернуть), «наличные»', async () => {
    const s = new MemStore()
    multi(s)
    const r = await run(s, msg('кофе 80'))
    await run(s, reply('вчера', asMessage(r[0])))
    expect(s.txRows[0].date).toBe('2026-10-20')
    await run(s, reply('наличные', asMessage(r[0])))
    expect(s.txRows[0].account_id).toBe('acc2-cash-0000')
    const d = await run(s, reply('удали', asMessage(r[0])))
    expect(s.txRows[0].deleted_at).not.toBeNull()
    const back = buttons(d)[0].callback_data
    await run(s, cb(back))
    expect(s.txRows[0].deleted_at).toBeNull()
  })

  it('«2 90» changes the second record of a list; someone else’s record is refused', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80\nтакси 150'))
    await run(s, reply('2 90', asMessage(r[0])))
    expect(s.txRows.map((t) => t.amount)).toEqual([80, 90])
    const her = await run(s, reply('2 100', asMessage(r[0]), PARTNER))
    expect(textOf(her)).toBe('Исправлять можно только свои записи')
    expect(s.txRows[1].amount).toBe(90)
  })
})

describe('/undo of a cleared batch', () => {
  it('returns the newest batch when it is newer than the last record', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ id: 'a', date: TODAY, deleted_at: '2026-10-21T09:59:00.000Z', deleted_batch: 'b1', rev: 7 })]
    expect(textOf(await run(s, msg('/undo')))).toBe('Вернул 1 запись')
    expect(s.txRows[0].deleted_at).toBeNull()
  })
})
