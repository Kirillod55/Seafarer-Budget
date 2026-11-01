// The rates as the bot and the app show them, one rule for both: buy → sell from real banks (bankRates.ts), and for a
// source that is down the official rate (hryvnia — НБУ, leu — НБМ, or the НБУ cross if НБМ is down too). No npm imports.
import { noBankRates, type BankRates, type BuySell } from './bankRates.ts'
import { money } from './format.ts'
import { currentRates } from './fx.ts'
import type { FxRate } from './types.ts'

const two = (v: BuySell, cur: string) => `${money(v.buy, cur)} → ${money(v.sell, cur)}`
const TITLE = { USD: 'Доллар', EUR: 'Евро' }
const SIGN = { USD: '💵', EUR: '💶' }

export interface RateBlock {
  unit: 'USD' | 'EUR'
  title: string
  uah: string | null
  mdl: string | null
  /** the same numbers for the app's table */
  cells: RateCell[]
}
export interface RateCell {
  label: 'Гривна' | 'Лей'
  buy: number | null
  sell: number | null
  /** the official rate, when the bank has not answered */
  one: number | null
}
export interface RatesView {
  date: string
  /** at least one bank answered: its lines are buy → sell */
  live: boolean
  blocks: RateBlock[]
  /** where the numbers really came from: «ПриватБанк / maib», «НБУ / НБМ», or a mix */
  source: string
}

export function ratesView(rates: FxRate[], today: string, bank: BankRates = noBankRates()): RatesView | null {
  const { date, pairs } = currentRates(rates, today)
  const live = pairs.some((p) => bank[p.unit].uah || bank[p.unit].mdl)
  if (!date && !live) return null
  const blocks = pairs.map((p): RateBlock => {
    const b = bank[p.unit]
    return {
      unit: p.unit,
      title: TITLE[p.unit],
      uah: b.uah ? two(b.uah, 'UAH') : p.uah !== null ? money(p.uah, 'UAH') : null,
      mdl: b.mdl ? two(b.mdl, 'MDL') : p.mdl !== null ? money(p.mdl, 'MDL') : null,
      cells: [
        { label: 'Гривна', buy: b.uah?.buy ?? null, sell: b.uah?.sell ?? null, one: b.uah ? null : p.uah },
        { label: 'Лей', buy: b.mdl?.buy ?? null, sell: b.mdl?.sell ?? null, one: b.mdl ? null : p.mdl },
      ],
    }
  })
  const uahFrom = pairs.some((p) => bank[p.unit].uah) ? 'ПриватБанк' : 'НБУ'
  const mdlFrom = pairs.some((p) => bank[p.unit].mdl) ? 'maib' : pairs.some((p) => p.mdlBank === 'BNM') ? 'НБМ' : 'НБУ'
  return { date: live ? today : (date as string), live, blocks, source: uahFrom === mdlFrom ? uahFrom : `${uahFrom} / ${mdlFrom}` }
}

export function ratesText(rates: FxRate[], today: string, dayLabel: (date: string) => string, bank: BankRates = noBankRates()): string {
  const v = ratesView(rates, today, bank)
  if (!v) return 'Курсов пока нет — попробуй позже'
  const head = `💱 Курс на ${dayLabel(v.date)}:${v.live ? '\nПокупка → продажа' : ''}`
  const blocks = v.blocks.map((b) =>
    [`${SIGN[b.unit]} ${b.title}:`, ...(b.uah ? [`🇺🇦 ${b.uah}`] : []), ...(b.mdl ? [`🇲🇩 ${b.mdl}`] : [])].join('\n'),
  )
  return [head, ...blocks, `🏦 ${v.source}`].join('\n\n')
}
