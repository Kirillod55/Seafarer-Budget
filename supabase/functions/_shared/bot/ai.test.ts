import { beforeEach, describe, expect, it } from 'vitest'
import { AI_FAILED } from './ai.ts'
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

it('an income under an expense category stays an income, without that category', async () => {
  const s = new MemStore()
  await withAi(s, groq([answer({ records: [rec({ kind: 'income', category: 'Прочее', note: 'премия' })] })]), msg('какие-то деньги 100'))
  expect(s.txRows[0]).toMatchObject({ kind: 'income', category_id: null })
})

describe('a plan: several actions, «Выполнить» first', () => {
  const multi = () => { const s = new MemStore(); s.settingsRow = { ...s.settingsRow!, accounts_mode: 'multi' } as never; return s }
  const plan = (over: Partial<AiAnswer>) => answer({ records: [], ...over })
  const say = 'создай новый счет - кэш и закинь 300 баксов на монобанк'
  const move = { amount: 300, currency: 'USD', from: null, to: 'монобанк' }
  const press = (update_id: number) => cb(`ai:ok:${update_id}`, { message_id: 9 })

  it('shows the actions and changes nothing; «Выполнить» runs them once, the missing target created too', async () => {
    const s = multi()
    const before = s.accountRows.length
    const q = msg(say)
    const shown = textOf(await withAi(s, groq([plan({ new_accounts: ['кэш'], transfers: [move] })]), q))
    expect(shown).toContain('1) Создать счёт «Кэш» с нулевым остатком')
    expect(shown).toContain('2) Создать счёт «Монобанк» с нулевым остатком')
    expect(shown).toContain('3) Перевод: Основной → Монобанк · $300')
    expect(s.accountRows).toHaveLength(before)
    expect(s.txRows).toHaveLength(0)
    const g = groq([])
    await withAi(s, g, press((q as { update_id: number }).update_id))
    expect(g.calls).toBe(0)
    expect(s.accountRows).toHaveLength(before + 2)
    expect(s.txRows).toHaveLength(1)
    expect(s.txRows[0]).toMatchObject({ kind: 'transfer', amount: 300, currency: 'USD' })
    await withAi(s, g, press((q as { update_id: number }).update_id))
    expect(s.txRows).toHaveLength(1)
  })
  it('an account phrase with a second action goes to the AI, not into the account name', async () => {
    const s = multi()
    const g = groq([plan({ new_accounts: ['Кэш'], transfers: [{ ...move, to: 'Кэш' }] })])
    expect(textOf(await withAi(s, g, msg('создай счёт Кэш и закинь на него 300 баксов')))).toContain('Перевод: Основной → Кэш · $300')
    expect(g.calls).toBe(1)
  })
  it('one account mode: says so, nothing is prepared', async () => {
    const s = new MemStore()
    expect(textOf(await withAi(s, groq([plan({ transfers: [move] })]), msg(say)))).toContain('Несколько счетов')
    expect(s.txRows).toHaveLength(0)
  })
  it('a transfer with a bad amount is dropped and named as such', async () => {
    const s = multi()
    const text = textOf(await withAi(s, groq([plan({ new_accounts: ['Кэш'], transfers: [{ ...move, amount: -5 }] })]), msg(say)))
    expect(text).toContain('Создать счёт «Кэш»')
    expect(text).not.toContain('Перевод')
    expect(text).toContain('Часть не разобрал')
  })
})

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
    const g = groq([answer({ unsure: true, reason: 'не уверен в категории' })])
    const q = await withAi(s, g, msg('взял всякое 2 раза по 75'))
    expect(s.txRows).toHaveLength(0)
    expect(textOf(q)).toContain('🤖 Понял так:')
    expect(buttons(q).map((b) => b.text)).toEqual(['Записать', 'Отмена'])
    await withAi(s, g, cb(buttons(q)[0].callback_data, { ...asMessage(q[0]), reply_to_message: { message_id: 5, text: 'взял всякое 2 раза по 75' } }))
    expect(s.txRows).toHaveLength(1)
  })

  // ruling 2026-10-26 (review Important 2): «Записать» saves the shown draft, never asks Groq again
  it('«Записать» saves exactly the shown records from the stored draft — Groq is not asked again', async () => {
    const s = new MemStore()
    const g = groq([
      answer({ unsure: true, records: [rec({ amount: 75, note: 'всякое' }), rec({ amount: 40, category: 'Продукты', note: 'хлеб', days_ago: 1 })] }),
      answer({ records: [rec({ amount: 999, note: 'другое' })] }),
    ])
    const update = msg('взял всякое 75 и хлеб 40')
    const q = await withAi(s, g, update)
    expect(buttons(q)[0].callback_data).toBe(`ai:ok:${update.update_id}`)
    const r = await withAi(s, g, cb(buttons(q)[0].callback_data, asMessage(q[0])))
    expect(g.calls).toBe(1)
    expect(s.txRows.map((t) => [t.amount, t.note, t.category_id, t.date])).toEqual([
      [75, 'всякое', cat('Транспорт и такси').id, '2026-10-21'],
      [40, 'хлеб', cat('Продукты').id, '2026-10-20'],
    ])
    expect(textOf(r)).toContain('📝 «взял всякое 75 и хлеб 40» — записал')
    // a second press does not save twice
    expect(textOf(await withAi(s, g, cb(buttons(q)[0].callback_data, asMessage(q[0]))))).toContain('Уже записано')
    expect(s.txRows).toHaveLength(2)
  })

  it('an expired or missing draft: «устарел», nothing saved, Groq not asked', async () => {
    const s = new MemStore()
    const g = groq([answer({ unsure: true }), answer({})])
    const q = await withAi(s, g, msg('взял всякое 2 раза по 75'))
    const later = new Date(Date.parse('2026-10-21T10:00:00Z') + 25 * 3600_000)
    const r = await run(s, cb(buttons(q)[0].callback_data, asMessage(q[0])), later, { groq: g })
    expect(textOf(r)).toContain('Черновик устарел — напиши ещё раз')
    expect(s.txRows).toHaveLength(0)
    // a 1.0-style button without a draft id
    expect(textOf(await withAi(s, g, cb('ai:ok', asMessage(q[0]))))).toContain('Черновик устарел — напиши ещё раз')
    expect(g.calls).toBe(1)
    expect(s.txRows).toHaveLength(0)
  })

  it('a dropped record (foreign category) also waits for the button', async () => {
    const s = new MemStore()
    const g = groq([answer({ records: [rec(), rec({ category: 'Казино' })] })])
    await withAi(s, g, msg('казино сотка'))
    expect(s.txRows).toHaveLength(0)
  })

  it('a timeout: the examples; an unsure rules record falls back to «Прочее»', async () => {
    const s = new MemStore()
    expect(textOf(await withAi(s, groq(['timeout']), msg('ну это самое')))).toBe(AI_FAILED)
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
