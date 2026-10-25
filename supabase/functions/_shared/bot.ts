// Telegram bot logic: pure, storage and transport are injected (BotStore, BotReply).
// Runs in Deno (Edge Function) and in vitest. No npm imports.
import { activeBalances, allowance, balanceUsd, contractStats, limitCrossing, limitStatus, monthReport, reservedUsd } from './calc.ts'
import { localDate, monthOf } from './dates.ts'
import { round2, usdRate } from './fx.ts'
import { money } from './format.ts'
import { parseMessage } from './parser.ts'
import type { Parsed } from './parser.ts'
import type { Account, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from './types.ts'

export interface BotStore {
  /** true if this update was already processed; otherwise remembers it and returns false */
  seenUpdate(updateId: number): Promise<boolean>
  settings(): Promise<Settings | null>
  categories(): Promise<Category[]>
  accounts(): Promise<Account[]>
  goals(): Promise<Goal[]>
  goalMoves(): Promise<GoalMove[]>
  limits(): Promise<Limit[]>
  /** all non-deleted transactions */
  transactions(): Promise<Transaction[]>
  /** known rates; fetches today's rate first when it is missing */
  rates(): Promise<FxRate[]>
  insertTx(t: Transaction): Promise<void>
  updateTx(id: string, patch: Partial<Transaction>): Promise<void>
  insertGoalMove(m: GoalMove): Promise<void>
  updateCategory(id: string, patch: Partial<Category>): Promise<void>
}

export interface BotReply {
  method: 'sendMessage' | 'answerCallbackQuery' | 'editMessageText'
  payload: Record<string, unknown>
}

const OTHER_CATEGORY = 'прочее'
const NO_CATEGORY = { icon: '❔', name: 'Без категории' }

const HELP_TEXT = [
  'Пиши траты обычным текстом:',
  '• кофе 80 — трата в валюте по умолчанию',
  '• такси 15 eur — в другой валюте',
  '• вчера обед 200 — за вчера',
  '• +3000 usd — доход',
  '• цель машина 500 — отложить на цель',
  '',
  'Команды: /today — траты за сегодня, /month — итог месяца, /left — сколько можно тратить, /undo — отменить последнюю запись.',
].join('\n')

const NEED_APP = 'Сначала открой приложение — оно создаст настройки, и тогда бот заработает.'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const usd = (n: number) => money(n, 'USD')

function send(chatId: number, text: string, inlineKeyboard?: { text: string; callback_data: string }[][]): BotReply {
  const payload: Record<string, unknown> = { chat_id: chatId, text }
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard }
  return { method: 'sendMessage', payload }
}

function categoryOf(t: Transaction, categories: Category[]): { icon: string; name: string } {
  const c = t.category_id ? categories.find((x) => x.id === t.category_id) : undefined
  return c ? { icon: c.icon, name: c.name } : NO_CATEGORY
}

/** `☕ Кафе и рестораны · 80 ₴ ($1.94)`; income gets a «+»; USD-only amounts do not repeat the USD part. */
function describeTx(t: Transaction, categories: Category[]): string {
  const c = categoryOf(t, categories)
  const base = `${t.kind === 'income' ? '+' : ''}${money(t.amount, t.currency)}`
  let amountPart = base
  if (t.currency !== 'USD') {
    if (t.rate_pending && t.amount_usd === 0) amountPart = `${base} (курс уточнится)`
    else amountPart = `${base} (${t.rate_pending ? '≈' : ''}${usd(t.amount_usd)})`
  }
  return `${c.icon} ${c.name} · ${amountPart}`
}

function undoButton(txId: string) {
  return { text: 'Отменить', callback_data: `u:${txId}` }
}

// Prepositions and conjunctions: «за квартиру» must not teach «за» (it would then catch «заправка»).
const STOPWORDS = new Set([
  'за', 'на', 'в', 'во', 'с', 'со', 'для', 'по', 'к', 'от', 'из', 'и', 'а', 'у', 'о', 'об', 'до', 'при', 'про',
])
const MIN_LETTERS = 3

/** The note word worth learning as a keyword: the first one with >= 3 letters that is not a stopword. */
function learnableWord(note: string): string | null {
  for (const raw of note.trim().split(/\s+/)) {
    const w = raw.replace(/^[.,!?;:()"'«»]+|[.,!?;:()"'«»]+$/gu, '').toLowerCase()
    if (STOPWORDS.has(w)) continue
    if ((w.match(/\p{L}/gu) ?? []).length >= MIN_LETTERS) return w
  }
  return null
}

function activeExpenseCategories(categories: Category[]): Category[] {
  return categories.filter((c) => !c.deleted && !c.archived && c.kind === 'expense').sort((a, b) => a.sort - b.sort)
}

function rateFor(rates: FxRate[], currency: string, date: string) {
  const r = usdRate(rates, currency, date)
  if (!r) return { rate_usd: 0, rate_pending: true, toUsd: (_: number) => 0 }
  return { rate_usd: r.rate, rate_pending: !r.exact, toUsd: (a: number) => round2(a * r.rate) }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
export async function handleUpdate(
  // deno-lint-ignore no-explicit-any
  update: any,
  ownerChatId: number,
  store: BotStore,
  now: Date,
  uuid: () => string,
): Promise<BotReply[]> {
  const chatId: unknown = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id
  if (chatId !== ownerChatId) return []
  const text: unknown = update?.message?.text
  const isCallback = Boolean(update?.callback_query)
  if (!isCallback && typeof text !== 'string') return []

  if (typeof update.update_id === 'number' && (await store.seenUpdate(update.update_id))) return []

  const settings = await store.settings()
  if (!settings) {
    if (isCallback) {
      return [{ method: 'answerCallbackQuery', payload: { callback_query_id: update.callback_query.id, text: NEED_APP } }]
    }
    return [send(ownerChatId, NEED_APP)]
  }

  if (isCallback) return handleCallback(update.callback_query, ownerChatId, store)
  return handleText(text as string, ownerChatId, settings, store, now, uuid)
}

// ---------------------------------------------------------------------------
// text messages
// ---------------------------------------------------------------------------
async function handleText(
  text: string,
  chatId: number,
  settings: Settings,
  store: BotStore,
  now: Date,
  uuid: () => string,
): Promise<BotReply[]> {
  const today = localDate(now, settings.timezone)
  const [categories, accounts] = await Promise.all([store.categories(), store.accounts()])

  const parsed = parseMessage(text, {
    currencies: settings.currencies,
    defaultCurrency: settings.default_currency,
    categories,
    accounts,
    accountsMode: settings.accounts_mode,
    today,
  })

  switch (parsed.type) {
    case 'error':
      return [send(chatId, HELP_TEXT)]
    case 'command':
      return runCommand(parsed.command, chatId, settings, categories, store, today)
    case 'goal':
      return runGoal(parsed, chatId, store, now, uuid)
    case 'tx':
      return saveTx(parsed, chatId, categories, accounts, store, now, today, uuid)
  }
}

async function saveTx(
  p: Extract<Parsed, { type: 'tx' }>,
  chatId: number,
  categories: Category[],
  accounts: Account[],
  store: BotStore,
  now: Date,
  today: string,
  uuid: () => string,
): Promise<BotReply[]> {
  const live = accounts.filter((a) => !a.deleted && !a.archived).sort((a, b) => a.sort - b.sort)
  const account =
    (p.accountId ? accounts.find((a) => a.id === p.accountId) : undefined) ??
    live.find((a) => a.is_default) ??
    live[0]
  if (!account) return [send(chatId, 'Нет счёта — открой приложение, чтобы он создался.')]

  // unmatched expense -> «Прочее» (spec §5), the user can re-pick with buttons
  let categoryId = p.categoryId
  const unmatched = categoryId === null && p.kind === 'expense'
  if (unmatched) {
    categoryId =
      activeExpenseCategories(categories).find((c) => c.name.toLowerCase() === OTHER_CATEGORY)?.id ?? null
  }

  const rates = await store.rates()
  const fx = rateFor(rates, p.currency, p.date)
  const tx: Transaction = {
    id: uuid(),
    deleted: false,
    kind: p.kind,
    amount: p.amount,
    currency: p.currency,
    rate_usd: fx.rate_usd,
    amount_usd: fx.toUsd(p.amount),
    rate_pending: fx.rate_pending,
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: categoryId,
    date: p.date,
    note: p.note,
    source: 'bot',
    created_at: now.toISOString(),
    author: 'owner',
    archived: false,
    deleted_at: null,
    deleted_batch: null,
  }

  // limit check needs the spending before this transaction
  let limitLine = ''
  if (tx.kind === 'expense' && categoryId) {
    const limits = await store.limits()
    const limit = limits.find((l) => !l.deleted && l.category_id === categoryId)
    if (limit) {
      const before = await store.transactions()
      const month = monthOf(tx.date)
      const b = limitStatus(limit, before, month)
      const a = limitStatus(limit, [...before, tx], month)
      const crossing = limitCrossing(b.share, a.share)
      const name = categories.find((c) => c.id === categoryId)?.name ?? ''
      const emoji = crossing === 'over' ? '🔴 ' : crossing === 'warn' ? '⚠️ ' : ''
      limitLine = `\n${emoji}${name} за месяц: ${usd(a.spentUsd)} из ${usd(limit.monthly_usd)}`
    }
  }

  await store.insertTx(tx)

  let line = describeTx(tx, categories)
  if (tx.date !== today) line += ` · ${tx.date}`
  line += limitLine

  const keyboard: { text: string; callback_data: string }[][] = []
  if (unmatched) {
    line += '\n\nНе нашёл категорию, записал в «Прочее». Если нужно, выбери другую:'
    const others = activeExpenseCategories(categories).filter((c) => c.id !== categoryId)
    for (let i = 0; i < others.length; i += 2) {
      keyboard.push(
        others.slice(i, i + 2).map((c) => ({ text: `${c.icon} ${c.name}`, callback_data: `c:${tx.id}:${c.sort}` })),
      )
    }
  }
  keyboard.push([undoButton(tx.id)])
  return [send(chatId, line, keyboard)]
}

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------
async function runGoal(
  p: Extract<Parsed, { type: 'goal' }>,
  chatId: number,
  store: BotStore,
  now: Date,
  uuid: () => string,
): Promise<BotReply[]> {
  const goals = (await store.goals()).filter((g) => !g.deleted && !g.archived)
  const needle = p.goalName.trim().toLowerCase()
  const goal = needle
    ? (goals.find((g) => g.name.toLowerCase() === needle) ?? goals.find((g) => g.name.toLowerCase().startsWith(needle)))
    : undefined

  if (!goal) {
    const list = goals.length ? `\nТвои цели: ${goals.map((g) => g.name).join(', ')}` : '\nЦелей пока нет — создай в приложении'
    return [send(chatId, `Цель «${p.goalName}» не найдена${list}`)]
  }

  const rates = await store.rates()
  const r = usdRate(rates, p.currency, p.date)
  if (!r) return [send(chatId, 'Нет курса для этой валюты')]

  const amountUsd = round2(p.amount * r.rate)
  await store.insertGoalMove({
    id: uuid(),
    deleted: false,
    goal_id: goal.id,
    amount_usd: amountUsd,
    date: p.date,
    note: '',
    author: 'owner',
    source: 'bot',
    created_at: now.toISOString(),
  })
  const saved = round2(reservedUsd(await store.goalMoves(), goal.id))
  const sign = amountUsd >= 0 ? '+' : ''
  return [send(chatId, `🎯 ${goal.name}: ${sign}${usd(amountUsd)}\nНакоплено ${usd(saved)} из ${usd(goal.target_usd)}`)]
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function runCommand(
  command: 'today' | 'month' | 'left' | 'undo' | 'help',
  chatId: number,
  settings: Settings,
  categories: Category[],
  store: BotStore,
  today: string,
): Promise<BotReply[]> {
  switch (command) {
    case 'help':
      return [send(chatId, HELP_TEXT)]

    case 'today': {
      const rows = (await store.transactions()).filter((t) => t.kind === 'expense' && t.date === today)
      if (rows.length === 0) return [send(chatId, 'Сегодня трат нет')]
      const total = round2(rows.reduce((s, t) => s + t.amount_usd, 0))
      const lines = rows.map((t) => `• ${describeTx(t, categories)}`)
      return [send(chatId, `Сегодня потрачено ${usd(total)}:\n${lines.join('\n')}`)]
    }

    case 'month': {
      const txs = await store.transactions()
      const month = monthOf(today)
      const rep = monthReport(txs, month)
      if (rep.byCategory.length === 0) return [send(chatId, `За ${month} трат пока нет`)]
      const lines = rep.byCategory.map((c) => {
        const cat = categories.find((x) => x.id === c.categoryId)
        const label = cat ? `${cat.icon} ${cat.name}` : `${NO_CATEGORY.icon} ${NO_CATEGORY.name}`
        return `${label} · ${usd(c.usd)} (${Math.round(c.share * 100)}%)`
      })
      const prev = rep.prevTotalUsd > 0 ? `\nПрошлый месяц: ${usd(rep.prevTotalUsd)}` : ''
      return [send(chatId, `Итого за ${month}: ${usd(rep.totalUsd)}${prev}\n\n${lines.join('\n')}`)]
    }

    case 'left': {
      const [txs, moves, rates, accounts] = await Promise.all([
        store.transactions(),
        store.goalMoves(),
        store.rates(),
        store.accounts(),
      ])
      const free = round2(balanceUsd(activeBalances(txs, accounts), rates, today) - reservedUsd(moves))
      const lines = [`Свободно: ${money(free, 'USD', { whole: true })} (баланс за вычетом целей)`]
      if (settings.status === 'contract') {
        const st = contractStats(txs, settings, today)
        lines.push(`Заработано за контракт: ${usd(st.earnedUsd)}`)
        lines.push(`Отложено в этом месяце: ${usd(st.savedThisMonthUsd)}`)
        if (st.projectedUsd !== null) lines.push(`Прогноз к концу контракта: ${usd(st.projectedUsd)}`)
        return [send(chatId, lines.join('\n'))]
      }
      const a = allowance(free, settings, today)
      if (a.status === 'ok') {
        lines.push(`Можно тратить: ${usd(a.perMonth)} в месяц, ${usd(a.perDay)} в день (ещё ${a.days} дн. до выплаты)`)
      } else if (a.status === 'expired') {
        lines.push('Дата следующего контракта уже прошла — обнови её в приложении.')
      } else {
        lines.push('Укажи дату следующего контракта в приложении, и я посчитаю, сколько можно тратить.')
      }
      return [send(chatId, lines.join('\n'))]
    }

    case 'undo': {
      const last = (await store.transactions())
        .filter((t) => !t.deleted && t.source === 'bot')
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0]
      if (!last) return [send(chatId, 'Нечего отменять')]
      await store.updateTx(last.id, { deleted: true })
      return [send(chatId, `Удалено: ${describeTx(last, categories)}`)]
    }
  }
}

// ---------------------------------------------------------------------------
// inline button callbacks
// ---------------------------------------------------------------------------
async function handleCallback(
  // deno-lint-ignore no-explicit-any
  q: any,
  chatId: number,
  store: BotStore,
): Promise<BotReply[]> {
  const answer = (text?: string): BotReply => ({
    method: 'answerCallbackQuery',
    payload: text ? { callback_query_id: q.id, text } : { callback_query_id: q.id },
  })
  const edit = (text: string, keyboard?: { text: string; callback_data: string }[][]): BotReply => ({
    method: 'editMessageText',
    payload: {
      chat_id: chatId,
      message_id: q.message?.message_id,
      text,
      reply_markup: { inline_keyboard: keyboard ?? [] },
    },
  })

  const data = typeof q.data === 'string' ? q.data : ''
  const [kind, txId, sortRaw] = data.split(':')
  if ((kind !== 'c' && kind !== 'u') || !txId) return [answer()]

  const [txs, categories] = await Promise.all([store.transactions(), store.categories()])
  const tx = txs.find((t) => t.id === txId)
  if (!tx) return [answer('Запись не найдена или уже удалена')]

  if (kind === 'u') {
    await store.updateTx(tx.id, { deleted: true })
    return [answer('Удалено'), edit(`Удалено: ${describeTx(tx, categories)}`)]
  }

  const sort = Number(sortRaw)
  const target = categories.find((c) => !c.deleted && !c.archived && c.kind === tx.kind && c.sort === sort)
  if (!target) return [answer('Категория не найдена')]

  await store.updateTx(tx.id, { category_id: target.id })
  const updated: Transaction = { ...tx, category_id: target.id }

  let learned = ''
  const word = learnableWord(tx.note)
  if (word && !target.keywords.some((k) => k.toLowerCase().trim() === word)) {
    await store.updateCategory(target.id, { keywords: [...target.keywords, word] })
    learned = `\nЗапомнил: «${word}» → ${target.name}`
  }
  return [answer('Готово'), edit(`${describeTx(updated, categories)}${learned}`, [[undoButton(tx.id)]])]
}
