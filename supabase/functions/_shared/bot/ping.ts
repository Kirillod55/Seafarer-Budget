// /ping (spec §10): writes nothing; database time, the last record, the GitHub ping, Telegram delivery, Groq.
import { localDate } from '../dates.ts'
import { lastRecordAt, webhookProblem } from '../keepalive.ts'
import type { WebhookInfo } from '../keepalive.ts'
import { dateWord, send } from './ctx.ts'
import type { Ctx } from './ctx.ts'
import type { BotReply } from './types.ts'

export interface PingInfo {
  /** getWebhookInfo, or null when it failed */
  webhook: WebhookInfo | null
  /** the telegram-bot function URL */
  webhookUrl: string
}

const STALE_MS = 2 * 86_400_000

function clock(iso: string, tz: string): string {
  const o: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
  try {
    return new Intl.DateTimeFormat('ru-RU', { ...o, timeZone: tz }).format(new Date(iso))
  } catch {
    return new Intl.DateTimeFormat('ru-RU', { ...o, timeZone: 'Europe/Kiev' }).format(new Date(iso))
  }
}

function when(iso: string, ctx: Ctx): string {
  const day = localDate(new Date(iso), ctx.settings.timezone)
  return `${dateWord(day, ctx.today) || 'сегодня'}, ${clock(iso, ctx.settings.timezone)}`
}

export async function ping(ctx: Ctx, info?: () => Promise<PingInfo>): Promise<BotReply[]> {
  const t0 = Date.now()
  const [s, txs, moves] = await Promise.all([ctx.store.settings(), ctx.store.transactions(), ctx.store.goalMoves()])
  const dbMs = Date.now() - t0
  const lines = ['🏓 На связи', `База: ✓ ответила за ${dbMs} мс`]
  const last = lastRecordAt(txs, moves)
  lines.push(`Последняя запись: ${last ? when(last, ctx) : 'ещё нет'}`)
  const k = s?.keepalive_at ?? null
  const nowMs = ctx.now.getTime()
  if (!k) lines.push('Пинг из GitHub: ⚠️ ещё не было — проверь GitHub Actions')
  else if (nowMs - Date.parse(k) > STALE_MS) lines.push(`Пинг из GitHub: ⚠️ ${Math.floor((nowMs - Date.parse(k)) / 86_400_000)} дн. не было — проверь GitHub Actions`)
  else lines.push(`Пинг из GitHub: ${when(k, ctx)} ✓`)
  if (info) {
    try {
      const i = await info()
      const problem = i.webhook ? webhookProblem(i.webhook, i.webhookUrl, nowMs) : 'нет ответа от Telegram'
      lines.push(problem ? `Telegram: ⚠️ ${problem}` : 'Telegram: ✓ доставка без ошибок')
    } catch {
      lines.push('Telegram: ⚠️ нет ответа от Telegram')
    }
  }
  lines.push(ctx.ai ? 'Голосовые и ИИ: ✓ ключ подключён' : 'Голосовые и ИИ: не подключены')
  return [send(ctx, lines.join('\n'))]
}
