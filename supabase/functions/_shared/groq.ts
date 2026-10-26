// Groq for the bot (spec §5): speech-to-text and the live-text parser. Pure: the network is behind GroqPort
// (index.ts implements it with fetch and a 6 s timeout; tests stub it). No npm imports.
import { addDays } from './dates.ts'

export interface GroqPort {
  /** POST /openai/v1/chat/completions with { model, ...body }; resolves with the HTTP status and JSON body, throws on timeout/network */
  chat(model: string, body: object): Promise<{ status: number; body?: unknown }>
  /** POST /openai/v1/audio/transcriptions (whisper-large-v3-turbo); the recognised text */
  transcribe(audio: Uint8Array, filename: string, prompt: string): Promise<string>
}

export const MODEL = 'openai/gpt-oss-120b'
export const FALLBACK_MODEL = 'openai/gpt-oss-20b'
export const WHISPER_MODEL = 'whisper-large-v3-turbo'
export const AI_DAILY_LIMIT = 300
export const MAX_AI_RECORDS = 20
export const AI_COMMANDS = ['none', 'ping', 'today', 'month', 'left', 'undo', 'help'] as const
export type AiCommand = typeof AI_COMMANDS[number]

export interface AiLists {
  categories: string[]
  accounts: string[]
  currencies: string[]
}

export interface AiAnswer {
  records: { kind: 'expense' | 'income'; amount: number; currency: string; category: string; account: string | null; days_ago: number; note: string }[]
  command: AiCommand
  create_category: { name: string; kind: 'expense' | 'income' } | null
  unsure: boolean
  reason: string
}

export interface AiRecord { kind: 'expense' | 'income'; amount: number; currency: string; category: string; account: string | null; date: string; note: string }
export interface AiResult { records: AiRecord[]; dropped: number; command: AiCommand; createCategory: AiAnswer['create_category']; unsure: boolean; reason: string }

/** The strict JSON schema of the answer (`response_format: json_schema`, `strict: true`). */
export function aiSchema(l: AiLists): object {
  const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] })
  return {
    type: 'object',
    additionalProperties: false,
    required: ['records', 'command', 'create_category', 'unsure', 'reason'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'amount', 'currency', 'category', 'account', 'days_ago', 'note'],
          properties: {
            kind: { type: 'string', enum: ['expense', 'income'] },
            amount: { type: 'number' },
            currency: { type: 'string', enum: l.currencies },
            category: { type: 'string', enum: l.categories },
            account: l.accounts.length ? nullable({ type: 'string', enum: l.accounts }) : { type: 'null' },
            days_ago: { type: 'integer' },
            note: { type: 'string' },
          },
        },
      },
      command: { type: 'string', enum: [...AI_COMMANDS] },
      create_category: nullable({
        type: 'object', additionalProperties: false, required: ['name', 'kind'],
        properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['expense', 'income'] } },
      }),
      unsure: { type: 'boolean' },
      reason: { type: 'string' },
    },
  }
}

function systemPrompt(l: AiLists): string {
  return [
    'Ты разбираешь сообщения для учёта трат моряка. Верни только JSON по схеме.',
    'records — записи: kind (expense — трата, income — доход: зарплата, «получил», «+»), amount > 0, currency, category строго из списка, account из списка или null, days_ago (0 — сегодня, 1 — вчера, 2 — позавчера), note — короткая заметка словами пользователя.',
    'Сленг: сотка/сотня/стольник = 100, полтос/полтинник = 50, пятихатка = 500, косарь/штука/тыща = 1000, 2к = 2000, пол косаря = 500, полторы штуки = 1500. «2 кофе по 50» — одна запись на 100. Несколько трат в одном сообщении — несколько записей.',
    'Сигареты, стики, картриджи, жидкости для вейпа и прочее для курения → Продукты.',
    'Если записи нет, а человек просит действие: command = ping (проверка связи), today, month, left (сколько можно тратить), undo, help; иначе none. Просьба создать категорию → create_category {name, kind}.',
    'Если сомневаешься в сумме, категории или смысле — unsure = true и коротко объясни в reason.',
    `Категории: ${l.categories.join(', ')}.`,
    `Счета: ${l.accounts.length ? l.accounts.join(', ') : 'нет'}.`,
    `Валюты: ${l.currencies.join(', ')} (гривна — UAH, доллар/бакс — USD, евро — EUR, лей — MDL).`,
  ].join('\n')
}

export function buildAiRequest(text: string, l: AiLists): object {
  return {
    temperature: 0,
    messages: [{ role: 'system', content: systemPrompt(l) }, { role: 'user', content: text }],
    response_format: { type: 'json_schema', json_schema: { name: 'budget_message', strict: true, schema: aiSchema(l) } },
  }
}

/** Code checks the answer: amount in (0, 1 000 000), currency/category/account from the lists, date 0–60 days back, ≤ 20 records. */
export function validateAi(a: AiAnswer, l: AiLists, today: string): AiResult | null {
  if (!a || typeof a !== 'object' || !Array.isArray(a.records) || typeof a.unsure !== 'boolean') return null
  const records: AiRecord[] = []
  let dropped = 0
  for (const r of a.records) {
    const good = r && (r.kind === 'expense' || r.kind === 'income') && typeof r.amount === 'number' && r.amount > 0 && r.amount < 1_000_000 &&
      l.currencies.includes(r.currency) && l.categories.includes(r.category) && (r.account === null || l.accounts.includes(r.account)) &&
      Number.isInteger(r.days_ago) && r.days_ago >= 0 && r.days_ago <= 60 && records.length < MAX_AI_RECORDS
    if (!good) {
      dropped++
      continue
    }
    records.push({ kind: r.kind, amount: Math.round(r.amount * 100) / 100, currency: r.currency, category: r.category, account: r.account, date: addDays(today, -r.days_ago), note: String(r.note ?? '').trim().slice(0, 200) })
  }
  const command = (AI_COMMANDS as readonly string[]).includes(a.command) ? a.command : 'none'
  const cc = a.create_category && typeof a.create_category.name === 'string' && a.create_category.name.trim()
    ? { name: a.create_category.name.trim().slice(0, 30), kind: a.create_category.kind === 'income' ? 'income' as const : 'expense' as const }
    : null
  return { records, dropped, command, createCategory: cc, unsure: a.unsure, reason: String(a.reason ?? '') }
}

// Best effort per Edge Function instance: the cap protects the free Groq quota from a loop, not an exact count.
let counter = { day: '', n: 0 }
export function resetAiCount() {
  counter = { day: '', n: 0 }
}
function take(today: string): boolean {
  if (counter.day !== today) counter = { day: today, n: 0 }
  if (counter.n >= AI_DAILY_LIMIT) return false
  counter.n++
  return true
}

/** Ask the model (120b, then 20b on 429). null on no quota, both limited, error/timeout or an unusable answer. */
export async function askAi(groq: GroqPort, text: string, l: AiLists, today: string): Promise<AiResult | null> {
  if (!take(today)) return null
  const body = buildAiRequest(text, l)
  try {
    let res = await groq.chat(MODEL, body)
    if (res.status === 429) res = await groq.chat(FALLBACK_MODEL, body)
    if (res.status !== 200) return null
    // deno-lint-ignore no-explicit-any
    const content = (res.body as any)?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    return validateAi(JSON.parse(content) as AiAnswer, l, today)
  } catch {
    return null
  }
}

/** Whisper prompt: the user's words it should hear right. */
export function voicePrompt(l: AiLists): string {
  return `Траты: ${l.categories.join(', ')}. Счета: ${l.accounts.join(', ')}. Валюты: гривен, долларов, евро, леев (${l.currencies.join(', ')}).`
}
