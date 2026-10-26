// Routing a text message: slash commands, commands in plain words (spec §10), the phrases of groups 1–7,
// category creation, deleting; anything else is a record. A message with an amount is always a record
// unless a phrase pattern claims it first.
import { normalize } from '../parser.ts'
import { createCategory, CREATE_RE } from './categories.ts'
import { clearPhrase, deleteByDescription, restoreLatest, startClear } from './clear.ts'
import * as cmd from './commands.ts'
import { send } from './ctx.ts'
import type { Ctx } from './ctx.ts'
import { convert, CONVERT_RE, exchange, EXCHANGE_RE, rate, RATE_RE, reconcile, RECONCILE_RE, transfer, TRANSFER_RE } from './money.ts'
import { accountDelete, ACCOUNT_DELETE_RE, PREF_RE, prefPhrase, settingsMenu, SUMMARY_RE, summaryToggle } from './prefs.ts'
import { writeRecords } from './records.ts'
import { report, REPORT_RE, search, SEARCH_RE } from './reports.ts'
import { helpText, IN_APP, SHORT_HELP } from './texts.ts'
import type { BotReply } from './types.ts'

export type Command = 'start' | 'help' | 'today' | 'week' | 'month' | 'left' | 'undo' | 'balance' | 'goals' | 'limits' |
  'export' | 'settings' | 'clear' | 'last' | 'ping'

const SLASH = /^\/(start|help|today|week|month|left|undo|balance|goals|limits|export|settings|clear|last|ping)(?:@\w+)?(?:\s|$)/

const FILLERS = /(?<![\p{L}\d])(ээ+|эм+|слушай|пожалуйста|пж|плиз|а|ну|скажи|подскажи)(?![\p{L}\d])/gu
const PHRASES: [RegExp, Command][] = [
  [/^(сделай проверку|проверь связь|проверь базу|жива ли база|база жива|ты тут|ты здесь|работаешь|вс[её] работает|пинг|проверка|ping)$/, 'ping'],
  [/^(что сегодня|сколько потратил сегодня|сколько потратила сегодня|траты за сегодня|сегодня)$/, 'today'],
  [/^(итог месяца|сколько за месяц|отч[её]т|месяц)$/, 'month'],
  [/^(сколько осталось|сколько можно тратить|остаток|бюджет)$/, 'left'],
  [/^(отмени|отмена|удали последнее|верни как было)$/, 'undo'],
  [/^(помощь|что ты умеешь|как писать|как пользоваться|инструкция|help)$/, 'help'],
  [/^(сколько денег|что на сч[её]тах|баланс)$/, 'balance'],
  [/^(как цели|цели)$/, 'goals'],
  [/^(как лимиты|лимиты)$/, 'limits'],
  [/^(пришли выгрузку|выгрузка|экспорт|выгрузи)$/, 'export'],
  [/^(настройки|настройки бота)$/, 'settings'],
  [/^(за неделю|траты за неделю|сколько за неделю|неделя)$/, 'week'],
  [/^(очисти историю)$/, 'clear'],
]

/** A command from «/x» or plain words (fillers and punctuation ignored); null otherwise. */
export function commandOf(text: string): Command | null {
  const raw = text.trim().toLowerCase()
  const s = SLASH.exec(raw)
  if (s) return s[1] as Command
  const t = raw.replace(/[?!.,]/g, ' ').replace(FILLERS, ' ').replace(/\s+/g, ' ').trim()
  for (const [re, c] of PHRASES) if (re.test(t)) return c
  return null
}

export async function runCommand(ctx: Ctx, c: Command): Promise<BotReply[]> {
  switch (c) {
    case 'start': return [send(ctx, helpText(ctx, true), undefined, { html: true })]
    case 'help': return [send(ctx, helpText(ctx), undefined, { html: true })]
    case 'today': return cmd.today(ctx)
    case 'week': return cmd.week(ctx)
    case 'month': return cmd.month(ctx)
    case 'left': return cmd.left(ctx)
    case 'undo': return cmd.undo(ctx)
    case 'balance': return cmd.balance(ctx)
    case 'goals': return cmd.goals(ctx)
    case 'limits': return cmd.limits(ctx)
    case 'export': return cmd.exportCsv(ctx)
    case 'settings': return settingsMenu(ctx)
    case 'clear': return startClear(ctx)
    case 'last': return search(ctx, '/last')
    case 'ping': return pingHandler(ctx)
  }
}

/** Replaced by the full /ping of stage 6 (index.ts passes it in). */
export let pingHandler: (ctx: Ctx) => Promise<BotReply[]> = async (ctx) => [send(ctx, '🏓 На связи')]
export function setPingHandler(h: (ctx: Ctx) => Promise<BotReply[]>) {
  pingHandler = h
}

/**
 * Route one text. `confirmed` is true when a «Сохранить» button re-reads the text.
 * Returns null when nothing understood it (stage 5 then asks the AI).
 */
export async function route(ctx: Ctx, text: string, confirmed = false): Promise<BotReply[] | null> {
  const c = commandOf(text)
  if (c) return runCommand(ctx, c)
  const t = normalize(text).replace(/[?!]+$/, '')

  if (CREATE_RE.test(t)) return createCategory(ctx, text)
  if (/^(удали|убери|архивируй)\s+(категорию|цель)(?![\p{L}\d])/u.test(t)) return [send(ctx, IN_APP)]
  if (ACCOUNT_DELETE_RE.test(t)) return accountDelete(ctx, text)
  if (/^верни (удал[её]нное|вс[её])/.test(t)) return restoreLatest(ctx)
  const clear = clearPhrase(text)
  if (clear) return startClear(ctx, clear.scope, clear.kind)
  if (/^(удали|убери|сотри)\s/.test(t)) return deleteByDescription(ctx, text)
  if (SUMMARY_RE.test(t)) return summaryToggle(ctx, text)
  if (/^сколько (дней )?до посадки/.test(t)) return cmd.daysToLanding(ctx)
  if (PREF_RE.test(t)) return prefPhrase(ctx, text, confirmed)
  if (TRANSFER_RE.test(t + ' ')) return transfer(ctx, text)
  if (EXCHANGE_RE.test(t + ' ')) return exchange(ctx, text)
  if (RATE_RE.test(t)) return rate(ctx, text)
  if (CONVERT_RE.test(t)) {
    const r = await convert(ctx, text)
    if (r) return r
  }
  if (RECONCILE_RE.test(t + ' ')) {
    const r = await reconcile(ctx, text, confirmed)
    if (r) return r
  }
  if (SEARCH_RE.test(t)) return search(ctx, text)
  if (REPORT_RE.test(t) && !/^сколько \d/.test(t)) {
    const r = await report(ctx, text)
    if (r) return r
  }
  return writeRecords(ctx, text)
}

/** A text nothing understood: the short hint (looks like a record) or the help. */
export function fallback(ctx: Ctx, text: string): BotReply[] {
  const words = normalize(text).split(' ').filter((w) => /\p{L}/u.test(w))
  return words.length > 0 && words.length <= 4 ? [send(ctx, SHORT_HELP)] : [send(ctx, helpText(ctx), undefined, { html: true })]
}
