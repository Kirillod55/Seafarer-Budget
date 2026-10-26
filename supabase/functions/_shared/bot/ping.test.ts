import { describe, expect, it } from 'vitest'
import type { GroqPort } from '../groq.ts'
import { MemStore, msg, run, SETTINGS, seedTx, textOf } from './testkit.ts'

const HOOK = 'https://x.supabase.co/functions/v1/telegram-bot'
const info = (url = HOOK) => async () => ({ webhookUrl: HOOK, webhook: { url, pending_update_count: 0 } })
const groq = {} as GroqPort

describe('/ping (spec §10)', () => {
  it('writes nothing; shows the last record, a fresh GitHub ping, Telegram and AI lines', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, keepalive_at: '2026-10-21T07:17:00.000Z' }
    s.txRows = [seedTx({ created_at: '2026-10-20T18:40:00.000Z' })]
    const t = textOf(await run(s, msg('сделай проверку'), undefined, { pingInfo: info(), groq }))
    expect(t).toMatch(/^🏓 На связи\nБаза: ✓ ответила за \d+ мс/)
    expect(t).toContain('Последняя запись: вчера, 21:40')
    expect(t).toContain('Пинг из GitHub: сегодня, 10:17 ✓')
    expect(t).toContain('Telegram: ✓ доставка без ошибок')
    expect(t).toContain('Голосовые и ИИ: ✓ ключ подключён')
    expect(s.txRows).toHaveLength(1)
    expect(s.writes).toEqual([])
  })

  it('an old keepalive_at warns; a wrong webhook shows; no key — «не подключены»', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, keepalive_at: '2026-10-18T07:17:00.000Z' }
    const t = textOf(await run(s, msg('/ping'), undefined, { pingInfo: info('https://other') }))
    expect(t).toContain('Пинг из GitHub: ⚠️ 3 дн. не было — проверь GitHub Actions')
    expect(t).toContain('Telegram: ⚠️ вебхук указывает на другой адрес')
    expect(t).toContain('Голосовые и ИИ: не подключены')
  })
})
