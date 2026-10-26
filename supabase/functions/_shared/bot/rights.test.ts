// Ruling 2026-10-26 (review of stages 3–6, Important 1): Masha keeps settings, goals and limits (spec §9
// «полный доступ»), but deleting is the owner's: accounts, categories, /clear and records that are not hers.
import { describe, expect, it } from 'vitest'
import { buttons, cb, MemStore, msg, NOW, OWNER, PARTNER, run, SETTINGS, seedTx, textOf, TODAY } from './testkit.ts'
import type { Account } from '../types.ts'

const acc = (id: string, name: string, sort: number): Account => ({ id, deleted: false, name, aliases: [], is_default: sort === 0, archived: false, sort })
const multi = (s: MemStore) => {
  s.settingsRow = { ...SETTINGS, accounts_mode: 'multi', partner_name: 'Маша' }
  s.accountRows = [acc('acc1', 'Основной', 0), acc('acc3-mono-0000', 'Монобанк', 1)]
}

describe('partner rights: deleting is the owner’s', () => {
  it('«удали счёт» from Masha: a short explanation, no «Да», and a stale «Да» does nothing', async () => {
    const s = new MemStore()
    multi(s)
    const r = await run(s, msg('удали счёт монобанк', PARTNER))
    expect(textOf(r)).toBe('Удалять счета может только Кирилл')
    expect(buttons(r)).toEqual([])
    const yes = await run(s, cb('acd:acc3-mon', {}, PARTNER))
    expect(textOf(yes)).toContain('Удалять счета может только Кирилл')
    expect(s.accountRows.find((a) => a.id === 'acc3-mono-0000')!.deleted).toBe(false)
  })

  it('«удали категорию» from Masha: only Kirill; Kirill is sent to the app', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('удали категорию кафе', PARTNER)))).toBe('Удалять категории может только Кирилл')
    expect(textOf(await run(s, msg('удали категорию кафе', OWNER)))).not.toContain('только Кирилл')
  })

  it('/clear and «удали траты за неделю» from Masha: only Kirill', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('/clear', PARTNER)))).toBe('Удалять историю может только Кирилл')
    expect(textOf(await run(s, msg('удали траты за неделю', PARTNER)))).toBe('Удалять историю может только Кирилл')
  })

  it('«удали …» of Kirill’s record from Masha: explained, nothing offered; her own is offered', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ id: 'k1', kind: 'expense', amount: 80, currency: 'UAH', amount_usd: 1.94, note: 'кофе', author: 'owner', date: TODAY })]
    const r = await run(s, msg('удали кофе 80', PARTNER))
    expect(textOf(r)).toBe('Это запись Кирилла — удалить её может только он')
    expect(buttons(r)).toEqual([])
    s.txRows.push(seedTx({ id: 'm1', kind: 'expense', amount: 80, currency: 'UAH', amount_usd: 1.94, note: 'кофе', author: 'partner', date: TODAY }))
    const mine = await run(s, msg('удали кофе 80', PARTNER))
    expect(textOf(mine)).toContain('Удалить?')
    expect(buttons(mine)[0].callback_data).toMatch(/^dd:m1:/)
  })

  it('Masha keeps settings, goals and limits (spec §9 «полный доступ»)', async () => {
    const s = new MemStore()
    const q = await run(s, msg('запас 500$', PARTNER))
    expect(textOf(q)).toContain('Запас к посадке $500')
    const m = await run(s, cb('st:r:3', {}, PARTNER), NOW)
    expect(textOf(m)).not.toContain('только Кирилл')
    expect(s.settingsRow!.remind_after_days).toBe(3)
    expect(textOf(await run(s, msg('новая цель отпуск 2000$ к июню', PARTNER)))).toContain('Новая цель «Отпуск»')
    expect(textOf(await run(s, msg('лимит на кафе 150$', PARTNER)))).toContain('Лимит на «Кафе и рестораны»')
  })
})
