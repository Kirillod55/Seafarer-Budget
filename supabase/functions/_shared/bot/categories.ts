// «создай категорию Спорт [и впиши туда зал 500 | , впиши туда последнюю трату | и перенеси туда все сигареты за этот месяц]».
import { alive } from '../alive.ts'
import { categoryStyle } from '../defaults.ts'
import { monthOf } from '../dates.ts'
import { parseRecords } from '../multi.ts'
import { matchCategory, matchDictionary } from '../parser.ts'
import type { TxParsed } from '../parser.ts'
import type { Category } from '../types.ts'
import { answer, edit } from './callbacks.ts'
import type { Query } from './callbacks.ts'
import { activeCategories, byShort, describeTx, load, partnerName, records, send, short, toOwner, usd } from './ctx.ts'
import type { Ctx } from './ctx.ts'
import { OTHER_EXPENSE, parseCtx, saveMany } from './records.ts'
import type { BotReply } from './types.ts'

const COLORS = ['#30B455', '#FF9500', '#0A84FF', '#AF52DE', '#32ADE6', '#FF3B30', '#FF2D55', '#FFCC00', '#A2845E', '#8E8E93']
const GREY = '#8E8E93'
const GLYPH_BY_WORD: [RegExp, string][] = [
  [/спорт|зал|фитнес|gym|трениров/, 'gym'], [/подписк|netflix|spotify|youtube|связь|телефон/, 'phone'], [/подар/, 'gift'],
  [/книг|курс|учёб|учеб|школ/, 'book'], [/путеш|отел|отпуск|билет/, 'plane'], [/топлив|бензин|заправ/, 'fuel'],
  [/одежд|обув/, 'shirt'], [/кафе|еда|кофе|ресторан|обед/, 'coffee'], [/дом|квартир|жиль/, 'home'], [/машин|авто/, 'car'],
  [/здоров|аптек|врач/, 'health'], [/кино|развлеч|игр/, 'ticket'], [/продукт|магазин/, 'cart'], [/зарплат|фриланс|доход/, 'wallet'],
]
const EMOJI: Record<string, string> = {
  gym: '🏋️', phone: '📱', gift: '🎁', book: '📚', plane: '✈️', fuel: '⛽', shirt: '👕', coffee: '☕', home: '🏠', car: '🚗',
  health: '💊', ticket: '🎬', cart: '🛒', wallet: '💰', tag: '🏷',
}

export const CREATE_RE = /^(создай|добавь|заведи|сделай|новая|создать|добавить)\s+(новую\s+)?категори[юяи](?![\p{L}\d])|^хочу отдельно считать\s/u

export function parseCreate(text: string): { name: string; kind: 'expense' | 'income'; rest: string } | null {
  const t = text.trim().replace(/\s+/g, ' ')
  const low = t.toLowerCase()
  if (!CREATE_RE.test(low)) return null
  const kind = /(?<![\p{L}])доход(ов|а)?(?![\p{L}])/u.test(low) ? 'income' : 'expense'
  let name = ''
  let rest = ''
  const q = /["«“]([^"»”]+)["»”]/.exec(t)
  if (q) {
    name = q[1]
    rest = t.slice(q.index + q[0].length)
  } else {
    const m = /(?:категори[юяи]|считать)\s+(?:доход(?:ов|а)?\s+)?(.+)$/i.exec(t)
    if (!m) return null
    const tail = m[1]
    const cut = /\s+и\s+|,/.exec(tail)
    name = cut ? tail.slice(0, cut.index) : tail
    rest = cut ? tail.slice(cut.index) : ''
  }
  name = name.trim().slice(0, 30)
  if (!name) return null
  rest = rest.replace(/^\s*(,|и)\s*/i, '').replace(/^(впиши|запиши|добавь|перенеси)\s+(туда|в неё|в нее)?\s*/i, (m) => `${m.split(/\s+/)[0].toLowerCase()} `).trim()
  return { name: name[0].toUpperCase() + name.slice(1), kind, rest }
}

function styleFor(name: string, cats: Category[]): { glyph: string; color: string } {
  const low = name.toLowerCase()
  const glyph = GLYPH_BY_WORD.find(([re]) => re.test(low))?.[1] ?? 'tag'
  const used = new Set(cats.filter((c) => alive(c)).map((c) => categoryStyle(c).color))
  return { glyph, color: COLORS.find((c) => !used.has(c)) ?? GREY }
}

export async function createCategory(ctx: Ctx, text: string): Promise<BotReply[] | null> {
  const p = parseCreate(text)
  if (!p) return null
  const snap = await load(ctx)
  const same = snap.categories.find((c) => c.name.toLowerCase() === p.name.toLowerCase())
  if (same && same.archived) {
    return [send(ctx, `Категория «${same.name}» в архиве`, [[{ text: 'Вернуть из архива', callback_data: `cra:${short(same.id)}` }]])]
  }
  if (same) return [send(ctx, `Категория «${same.name}» уже есть`)]

  const { glyph, color } = styleFor(p.name, snap.categories)
  const cat: Category = {
    id: ctx.uuid(), deleted: false, name: p.name, kind: p.kind, icon: EMOJI[glyph] ?? '🏷', keywords: [p.name.toLowerCase()],
    archived: false, sort: Math.max(0, ...snap.categories.map((c) => c.sort)) + 1, color, glyph, deleted_at: null, deleted_batch: null,
  }
  await ctx.store.insert('categories', cat)
  snap.categories.push(cat)
  const head = `Создал категорию ${cat.icon} ${cat.name} (${p.kind === 'income' ? 'доход' : 'расход'})`
  const notice = toOwner(ctx, `${partnerName(ctx.settings)} создала категорию ${cat.name}`)
  const verb = p.rest.split(' ')[0]?.toLowerCase()
  const body = p.rest.split(' ').slice(1).join(' ')

  if (verb === 'перенеси' || (verb && /последн/.test(body))) {
    const mine = snap.txs.filter((t) => t.kind === p.kind && (ctx.author === 'owner' || t.author === ctx.author))
    let moved = []
    if (/последн/.test(body)) {
      const last = mine.filter((t) => t.author === ctx.author).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
      moved = last ? [last] : []
    } else {
      const word = body.replace(/^(все|всё)\s+/i, '').replace(/\s+за\s+.*$/i, '').trim().toLowerCase().split(' ')[0] ?? ''
      const stem = word.slice(0, Math.max(4, word.length - 2))
      const month = monthOf(ctx.today)
      moved = stem ? mine.filter((t) => monthOf(t.date) === month && t.note.toLowerCase().includes(stem)) : []
    }
    for (const t of moved) await ctx.store.updateTx(t.id, { category_id: cat.id })
    const total = moved.reduce((s, t) => s + t.amount_usd, 0)
    const line = moved.length === 1 ? `Перенёс: ${describeTx({ ...moved[0], category_id: cat.id }, snap, ctx)}` : `Перенёс ${records(moved.length)} · ${usd(total)}`
    return [send(ctx, `${head}\n${line}`, [[{ text: 'Отменить', callback_data: `umv:${short(cat.id)}` }]]), ...notice]
  }

  if (body || (verb && !['впиши', 'запиши', 'добавь'].includes(verb))) {
    const source = ['впиши', 'запиши', 'добавь'].includes(verb) ? body : p.rest
    const r = parseRecords(source, parseCtx(ctx, snap))
    const items: TxParsed[] = r.type === 'records' || r.type === 'ask' ? r.items : r.type === 'single' && r.parsed.type === 'tx' ? [r.parsed] : []
    if (items.length) {
      for (const i of items) {
        i.categoryId = cat.id
        i.kind = p.kind
      }
      const replies = await saveMany(ctx, items, [head])
      const kb = (replies[0].payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
      kb[kb.length - 1] = [{ text: 'Отменить все', callback_data: `uall:${short(cat.id)}` }]
      return [...replies, ...notice]
    }
  }
  return [send(ctx, head, [[{ text: 'Отменить', callback_data: `ucat:${short(cat.id)}` }]]), ...notice]
}

export async function categoryCallback(ctx: Ctx, q: Query, data: string): Promise<BotReply[] | null> {
  const [kind, id] = data.split(':')
  if (kind !== 'cra' && kind !== 'ucat' && kind !== 'umv') return null
  const [snap, all] = await Promise.all([load(ctx), ctx.store.categories()])
  const cat = byShort(all, id)
  if (!cat) return [answer(q, 'Категория не найдена')]
  if (kind === 'cra') {
    await ctx.store.update('categories', cat.id, { archived: false })
    return [answer(q, 'Готово'), edit(ctx, q, `Вернул категорию «${cat.name}» из архива`)]
  }
  const inside = snap.txs.filter((t) => t.category_id === cat.id)
  if (kind === 'umv') {
    const others = activeCategories(snap.categories).filter((c) => c.id !== cat.id)
    const fallback = others.find((c) => c.kind === cat.kind && (cat.kind === 'income' || c.name.toLowerCase() === OTHER_EXPENSE))
    for (const t of inside) {
      const words = t.note.toLowerCase().split(/\s+/)
      const back = matchCategory(words, others, cat.kind) ?? matchDictionary(words, others, cat.kind) ?? fallback
      await ctx.store.updateTx(t.id, { category_id: back?.id ?? null })
    }
  } else if (inside.length) {
    return [answer(q, 'В категории уже есть записи — удали её в приложении')]
  }
  await ctx.store.update('categories', cat.id, { deleted: true })
  return [answer(q, 'Отменено'), edit(ctx, q, `Отменил: категория «${cat.name}» удалена`)]
}
