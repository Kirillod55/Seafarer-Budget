// Ruling 2026-10-26 (review of stages 3–6, Important 3): «Отменить» buttons put rows in the 24 h bin (one
// deleted_batch, «Вернуть»), carry the minute they were made and stop working after an hour; a category with
// records is never deleted.
import { describe, expect, it } from 'vitest'
import { asMessage, buttons, cb, MemStore, msg, NOW, OWNER, run, SETTINGS, textOf } from './testkit.ts'
import { minuteOf } from './ctx.ts'

const TIMEOUT = 'Время вышло — удали через /clear или в приложении'
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
const binned = (r: { deleted: boolean; deleted_at?: string | null }) => !r.deleted && Boolean(r.deleted_at)
const press = (s: MemStore, data: string, message: object = {}, now = NOW) => run(s, cb(data, message, OWNER), now)

describe('«Отменить» goes through the bin', () => {
  it('one record: stamped button, bin with a batch, «Вернуть» brings it back', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    const t = s.txRows[0]
    const undo = buttons(r).find((b) => b.text === 'Отменить')!
    expect(undo.callback_data).toBe(`u:${t.id}:${minuteOf(NOW)}`)
    const u = await press(s, undo.callback_data, asMessage(r[0]))
    expect(s.txRows[0].deleted).toBe(false)
    expect(binned(s.txRows[0])).toBe(true)
    expect(s.txRows[0].deleted_batch).toBeTruthy()
    expect(textOf(u)).toContain('Удалено: ☕ Кафе и рестораны')
    const back = buttons(u).find((b) => b.text === 'Вернуть')!
    expect(back.callback_data).toBe(`rs:${s.txRows[0].deleted_batch}`)
    await press(s, back.callback_data)
    expect(s.txRows[0]).toMatchObject({ deleted: false, deleted_at: null, deleted_batch: null })
  })

  it('after an hour, or a button without a stamp: «Время вышло», nothing removed', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80'))
    const data = buttons(r).find((b) => b.text === 'Отменить')!.callback_data
    expect(textOf(await press(s, data, asMessage(r[0]), later(61)))).toContain(TIMEOUT)
    expect(textOf(await press(s, `u:${s.txRows[0].id}`))).toContain(TIMEOUT)
    expect(s.txRows[0]).toMatchObject({ deleted: false, deleted_at: null })
    // within the hour it works
    await press(s, data, asMessage(r[0]), later(59))
    expect(binned(s.txRows[0])).toBe(true)
  })

  it('«Отменить все»: one batch for all, «Вернуть» restores all; expires after an hour', async () => {
    const s = new MemStore()
    const r = await run(s, msg('кофе 80\nтакси 150\nатб 420'))
    const all = buttons(r).find((b) => b.text === 'Отменить все')!.callback_data
    expect(textOf(await press(s, all, asMessage(r[0]), later(61)))).toContain(TIMEOUT)
    expect(s.txRows.every((t) => t.deleted_at === null)).toBe(true)
    const u = await press(s, all, asMessage(r[0]))
    expect(s.txRows.every(binned)).toBe(true)
    expect(new Set(s.txRows.map((t) => t.deleted_batch)).size).toBe(1)
    await press(s, buttons(u).find((b) => b.text === 'Вернуть')!.callback_data)
    expect(s.txRows.every((t) => !t.deleted && t.deleted_at === null)).toBe(true)
  })

  it('«создай категорию … и впиши туда»: «Отменить все» bins the records and the new category together', async () => {
    const s = new MemStore()
    const r = await run(s, msg('создай категорию Спорт и впиши туда зал 500'))
    const sport = () => s.categoryRows.find((c) => c.name === 'Спорт')!
    const u = await press(s, buttons(r).find((b) => b.text === 'Отменить все')!.callback_data, asMessage(r[0]))
    expect(binned(s.txRows[0])).toBe(true)
    expect(binned(sport())).toBe(true)
    expect(sport().deleted_batch).toBe(s.txRows[0].deleted_batch)
    await press(s, buttons(u).find((b) => b.text === 'Вернуть')!.callback_data)
    expect(sport()).toMatchObject({ deleted: false, deleted_at: null })
    expect(s.txRows[0]).toMatchObject({ deleted: false, deleted_at: null })
  })

  it('a category that got other records meanwhile is kept', async () => {
    const s = new MemStore()
    const r = await run(s, msg('создай категорию Спорт и впиши туда зал 500'))
    await run(s, msg('спорт 300'))
    const u = await press(s, buttons(r).find((b) => b.text === 'Отменить все')!.callback_data, asMessage(r[0]))
    expect(textOf(u)).toContain('Категорию оставил — в ней есть другие записи')
    expect(s.categoryRows.find((c) => c.name === 'Спорт')).toMatchObject({ deleted: false, deleted_at: null })
  })

  it('«Отменить» under a new empty category bins it; a category with records stays', async () => {
    const s = new MemStore()
    const r = await run(s, msg('создай категорию Рыбалка'))
    const data = buttons(r)[0].callback_data
    expect(data).toMatch(new RegExp(`^ucat:[0-9a-f-]{8}:${minuteOf(NOW)}$`))
    expect(textOf(await press(s, data, asMessage(r[0]), later(61)))).toContain(TIMEOUT)
    await run(s, msg('рыбалка 200'))
    expect(textOf(await press(s, data, asMessage(r[0])))).toContain('В категории уже есть записи')
    expect(s.categoryRows.find((c) => c.name === 'Рыбалка')!.deleted_at).toBeNull()
    s.txRows = []
    await press(s, data, asMessage(r[0]))
    const c = s.categoryRows.find((x) => x.name === 'Рыбалка')!
    expect(binned(c)).toBe(true)
  })

  it('a new goal and a new limit: «Отменить» bins them; «убери лимит» → «Отменить» brings the limit back', async () => {
    const s = new MemStore()
    const save = async (text: string) => {
      const q = await run(s, msg(text))
      return run(s, cb('ok', { ...asMessage(q[0]), reply_to_message: { message_id: 5, text } }))
    }
    const g = await save('новая цель отпуск 2000$ к июню')
    await press(s, buttons(g).find((b) => b.text === 'Отменить')!.callback_data)
    expect(binned(s.goalRows[0])).toBe(true)
    const l = await save('лимит на кафе 150$')
    const undoLimit = buttons(l).find((b) => b.text === 'Отменить')!.callback_data
    expect(textOf(await press(s, undoLimit, {}, later(61)))).toContain(TIMEOUT)
    expect(s.limitRows[0].deleted_at).toBeNull()
    await press(s, undoLimit)
    expect(binned(s.limitRows[0])).toBe(true)
    // a fresh limit, removed by words, comes back with its «Отменить»
    const l2 = await save('лимит на кафе 100$')
    expect(s.limitRows).toHaveLength(2)
    const removed = await save('убери лимит на кафе')
    expect(binned(s.limitRows[1])).toBe(true)
    const back = await press(s, buttons(removed).find((b) => b.text === 'Отменить')!.callback_data)
    expect(textOf(back)).toContain('Вернул лимит')
    expect(s.limitRows[1]).toMatchObject({ deleted: false, deleted_at: null })
    expect(l2).toBeTruthy()
  })

  it('a settings «Отменить» older than an hour does not revert a later change', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, reserve_usd: 0 }
    const q = await run(s, msg('запас 500$'))
    const done = await run(s, cb('ok', { ...asMessage(q[0]), reply_to_message: { message_id: 5, text: 'запас 500$' } }))
    const undo = buttons(done).find((b) => b.text === 'Отменить')!.callback_data
    expect(textOf(await press(s, undo, {}, later(61)))).toContain(TIMEOUT)
    expect(s.settingsRow!.reserve_usd).toBe(500)
    await press(s, undo)
    expect(s.settingsRow!.reserve_usd).toBe(0)
  })

  it('a goal move «Отменить» expires too', async () => {
    const s = new MemStore()
    s.goalRows = [{ id: 'g1', deleted: false, deleted_at: null, deleted_batch: null, name: 'Машина', target_usd: 1000, deadline: null, archived: false }]
    const r = await run(s, msg('цель машина 50$'))
    const undo = buttons(r)[0].callback_data
    expect(textOf(await press(s, undo, {}, later(61)))).toContain(TIMEOUT)
    expect(s.moveRows[0].deleted).toBe(false)
  })
})
