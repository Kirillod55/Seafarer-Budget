import { beforeEach, describe, expect, it } from 'vitest'
import { resetAiCount } from '../groq.ts'
import type { AiAnswer, GroqPort } from '../groq.ts'
import { asMessage, buttons, cat, cb, MemStore, msg, OWNER, run, textOf } from './testkit.ts'

type Rec = AiAnswer['records'][number]
const rec = (over: Partial<Rec> = {}): Rec => ({ kind: 'expense', amount: 100, currency: 'UAH', category: 'Транспорт и такси', account: null, days_ago: 0, note: 'такси', ...over })
const answer = (over: Partial<AiAnswer> = {}): AiAnswer => ({ records: [rec()], command: 'none', create_category: null, unsure: false, reason: '', ...over })

function groq(answers: (AiAnswer | 'timeout')[], heard = ''): GroqPort & { calls: number; prompts: string[] } {
  const g = {
    calls: 0,
    prompts: [] as string[],
    async chat() {
      g.calls++
      const a = answers.shift()
      if (!a || a === 'timeout') throw new Error('timeout')
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(a) } }] } }
    },
    async transcribe(_: Uint8Array, __: string, prompt: string) {
      g.prompts.push(prompt)
      return heard
    },
  }
  return g
}
const withAi = (s: MemStore, g: GroqPort, update: unknown) => run(s, update, undefined, { groq: g, voiceFile: async () => new Uint8Array([1]) })
const voiceMsg = (duration = 5) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 6, chat: { id: OWNER }, voice: { file_id: 'f1', duration } } })

beforeEach(() => resetAiCount())

describe('AI after the rules (spec §5)', () => {
  it('«кофе 80» never calls the AI', async () => {
    const s = new MemStore()
    const g = groq([])
    await withAi(s, g, msg('кофе 80'))
    expect(g.calls).toBe(0)
    expect(s.txRows).toHaveLength(1)
  })

  it('a sure answer is saved with «🤖 Понял так:» and teaches the word: next time no AI', async () => {
    const s = new MemStore()
    const g = groq([answer({ records: [rec({ note: 'самокат' })] })])
    const r = await withAi(s, g, msg('закинул сотку на самокат'))
    expect(textOf(r)).toContain('🤖 Понял так:')
    expect(s.txRows[0]).toMatchObject({ amount: 100, category_id: cat('Транспорт и такси').id, note: 'самокат' })
    expect(s.categoryRows.find((c) => c.name === 'Транспорт и такси')!.keywords).toContain('самокат')
    await withAi(s, g, msg('самокат 15'))
    expect(g.calls).toBe(1)
  })

  it('unsure: «🤖 Понял так» with «Записать», nothing saved until pressed', async () => {
    const s = new MemStore()
    const g = groq([answer({ unsure: true, reason: 'не уверен в категории' }), answer({ unsure: true })])
    const q = await withAi(s, g, msg('взял всякое 2 раза по 75'))
    expect(s.txRows).toHaveLength(0)
    expect(textOf(q)).toContain('🤖 Понял так:')
    expect(buttons(q).map((b) => b.text)).toEqual(['Записать', 'Отмена'])
    await withAi(s, g, cb('ai:ok', { ...asMessage(q[0]), reply_to_message: { message_id: 5, text: 'взял всякое 2 раза по 75' } }))
    expect(s.txRows).toHaveLength(1)
  })

  it('a dropped record (foreign category) also waits for the button', async () => {
    const s = new MemStore()
    const g = groq([answer({ records: [rec(), rec({ category: 'Казино' })] })])
    await withAi(s, g, msg('казино сотка'))
    expect(s.txRows).toHaveLength(0)
  })

  it('a timeout: «Не понял — напиши проще»; an unsure rules record falls back to «Прочее»', async () => {
    const s = new MemStore()
    expect(textOf(await withAi(s, groq(['timeout']), msg('ну это самое')))).toBe('Не понял — напиши проще, например: кофе 80')
    await withAi(s, groq(['timeout']), msg('непонятное 50'))
    expect(s.txRows[0].category_id).toBe(cat('Прочее').id)
  })

  it('a command from the AI runs only when it is sure, otherwise buttons', async () => {
    const s = new MemStore()
    expect(textOf(await withAi(s, groq([answer({ records: [], command: 'ping' })]), msg('слышь бот живой вообще')))).toContain('На связи')
    const q = await withAi(s, groq([answer({ records: [], command: 'ping', unsure: true })]), msg('эй как там оно'))
    expect(buttons(q).map((b) => b.callback_data)).toEqual(['cmd:ping', 'cmd:today', 'cmd:left', 'cmd:help'])
    expect(textOf(await run(s, cb('cmd:ping')))).toContain('На связи')
  })

  it('«создать категорию» from the AI creates it', async () => {
    const s = new MemStore()
    await withAi(s, groq([answer({ records: [], create_category: { name: 'Рыбалка', kind: 'expense' } })]), msg('хочу видеть отдельно траты на рыбалку'))
    expect(s.categoryRows.some((c) => c.name === 'Рыбалка')).toBe(true)
  })

  it('without a key the AI is never asked', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('ну это самое')))).toContain('Не вижу суммы')
  })
})

describe('voice messages', () => {
  it('heard text goes through the usual parser with «🎤 Услышал»', async () => {
    const s = new MemStore()
    const g = groq([], 'кофе восемьдесят гривен')
    const r = await withAi(s, g, voiceMsg())
    expect(textOf(r).startsWith('🎤 Услышал: «кофе восемьдесят гривен»\n☕ Кафе и рестораны · ₴80')).toBe(true)
    expect(s.txRows[0].amount).toBe(80)
    expect(g.prompts[0]).toContain('Кафе и рестораны')
  })

  it('too long, no key, nothing heard', async () => {
    const s = new MemStore()
    expect(textOf(await withAi(s, groq([], 'кофе 80'), voiceMsg(61)))).toBe('Голосовое длиннее минуты — запиши короче')
    expect(textOf(await run(s, voiceMsg()))).toBe('Голосовые пока не подключены')
    expect(textOf(await withAi(s, groq([], '  '), voiceMsg()))).toBe('Не расслышал — напиши текстом')
    expect(s.txRows).toHaveLength(0)
  })

  it('a question about a heard word keeps the heard text for the buttons', async () => {
    const s = new MemStore()
    const g = groq(['timeout'], 'кофе 50 сигареты 30 чек')
    const q = await withAi(s, g, voiceMsg())
    expect(textOf(q).startsWith('🎤 Услышал: «кофе 50 сигареты 30 чек»\nНе понял, к какой трате «чек»')).toBe(true)
    await run(s, cb('ow:2', { ...asMessage(q[0]), reply_to_message: { message_id: 6, voice: {} } }))
    expect(s.txRows.map((t) => t.note)).toEqual(['кофе', 'сигареты чек'])
  })
})
