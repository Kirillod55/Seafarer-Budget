import { beforeEach, describe, expect, it } from 'vitest'
import { AI_DAILY_LIMIT, aiSchema, askAi, resetAiCount, validateAi, voicePrompt } from './groq.ts'
import type { AiAnswer, AiLists, GroqPort } from './groq.ts'

const lists: AiLists = {
  categories: ['Продукты', 'Кафе и рестораны', 'Транспорт и такси', 'Зарплата'], accounts: ['Основной', 'ProCreditBank'],
  currencies: ['UAH', 'USD', 'EUR'],
}
const rec = (over: Partial<AiAnswer['records'][number]> = {}) => ({
  kind: 'expense' as const, amount: 100, currency: 'UAH', category: 'Транспорт и такси', account: null, days_ago: 0, note: 'такси', ...over,
})
const answer = (over: Partial<AiAnswer> = {}): AiAnswer => ({ records: [rec()], command: 'none', create_category: null, unsure: false, reason: '', ...over })

function port(replies: { status: number; body?: unknown }[] | Error): GroqPort & { models: string[] } {
  const models: string[] = []
  return {
    models,
    async chat(model) {
      models.push(model)
      if (replies instanceof Error) throw replies
      return replies.shift() ?? { status: 500 }
    },
    async transcribe() { return '' },
  }
}
const ok = (a: AiAnswer) => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify(a) } }] } })

beforeEach(() => resetAiCount())

describe('aiSchema', () => {
  it('is strict: every property required, no extra properties, categories/currencies as enums', () => {
    const s = aiSchema(lists) as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> }
    expect(s.additionalProperties).toBe(false)
    expect(s.required.sort()).toEqual(['command', 'create_category', 'reason', 'records', 'unsure'])
    expect(JSON.stringify(s)).toContain('"enum":["Продукты","Кафе и рестораны","Транспорт и такси","Зарплата"]')
  })
})

describe('validateAi', () => {
  const today = '2026-10-21'
  it('keeps good records and maps them to dates', () => {
    const v = validateAi(answer({ records: [rec({ days_ago: 1, account: 'ProCreditBank' })] }), lists, today)
    expect(v!.records).toEqual([{ kind: 'expense', amount: 100, currency: 'UAH', category: 'Транспорт и такси', account: 'ProCreditBank', date: '2026-10-20', note: 'такси' }])
    expect(v!.dropped).toBe(0)
  })

  it.each([
    ['a foreign category', rec({ category: 'Казино' })],
    ['amount <= 0', rec({ amount: 0 })],
    ['amount >= 1 000 000', rec({ amount: 1_000_000 })],
    ['a future date', rec({ days_ago: -1 })],
    ['older than 60 days', rec({ days_ago: 61 })],
    ['a currency not enabled', rec({ currency: 'MDL' })],
    ['an unknown account', rec({ account: 'Монобанк' })],
  ])('drops %s', (_, r) => {
    const v = validateAi(answer({ records: [r, rec()] }), lists, today)
    expect(v!.records).toHaveLength(1)
    expect(v!.dropped).toBe(1)
  })

  it('no more than 20 records', () => {
    const v = validateAi(answer({ records: Array.from({ length: 25 }, () => rec()) }), lists, today)
    expect(v!.records).toHaveLength(20)
    expect(v!.dropped).toBe(5)
  })

  it('garbage is not an answer', () => {
    expect(validateAi({ nope: 1 } as unknown as AiAnswer, lists, today)).toBeNull()
  })
})

describe('askAi', () => {
  it('120b first, 20b on 429; temperature 0 and json_schema', async () => {
    const p = port([{ status: 429 }, ok(answer())])
    let body: Record<string, unknown> = {}
    const chat = p.chat.bind(p)
    p.chat = async (m, b) => {
      body = b as Record<string, unknown>
      return chat(m, b)
    }
    const a = await askAi(p, 'закинул сотку на такси', lists, '2026-10-21')
    expect(p.models).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b'])
    expect(a?.records[0].amount).toBe(100)
    expect(body.temperature).toBe(0)
    expect((body.response_format as { type: string }).type).toBe('json_schema')
    expect(JSON.stringify(body.messages)).toContain('Продукты')
  })

  it('both models at the limit, an error, a timeout, bad JSON → null', async () => {
    expect(await askAi(port([{ status: 429 }, { status: 429 }]), 'x', lists, '2026-10-21')).toBeNull()
    expect(await askAi(port(new Error('timeout')), 'x', lists, '2026-10-21')).toBeNull()
    expect(await askAi(port([{ status: 200, body: { choices: [{ message: { content: '{oops' } }] } }]), 'x', lists, '2026-10-21')).toBeNull()
  })

  it(`stops after ${AI_DAILY_LIMIT} calls a day`, async () => {
    const p = port(Array.from({ length: AI_DAILY_LIMIT + 1 }, () => ok(answer())))
    for (let i = 0; i < AI_DAILY_LIMIT; i++) await askAi(p, 'x', lists, '2026-10-21')
    expect(await askAi(p, 'x', lists, '2026-10-21')).toBeNull()
    expect(p.models).toHaveLength(AI_DAILY_LIMIT)
  })
})

describe('voicePrompt', () => {
  it('names categories, accounts and currencies', () => {
    expect(voicePrompt(lists)).toContain('ProCreditBank')
    expect(voicePrompt(lists)).toContain('гривен')
  })
})
