// The rates message: /currency in the bot and the 08:00 message from the keepalive function. No npm imports.
// Buy / sell from real banks (bankRates.ts); a source that is down falls back to the official rate, marked as such.
import { noBankRates, type BankRates, type BuySell } from './bankRates.ts'
import { money } from './format.ts'
import { currentRates } from './fx.ts'
import type { FxRate } from './types.ts'

const two = (v: BuySell, cur: string) => `${money(v.buy, cur)} → ${money(v.sell, cur)}`
const TITLE = { USD: '💵 Доллар:', EUR: '💶 Евро:' }

export function ratesText(rates: FxRate[], today: string, dayLabel: (date: string) => string, bank: BankRates = noBankRates()): string {
  const { date, pairs } = currentRates(rates, today)
  const live = pairs.some((p) => bank[p.unit].uah || bank[p.unit].mdl)
  if (!date && !live) return 'Курсов пока нет — попробуй позже'
  const blocks = pairs.map((p) => {
    const b = bank[p.unit]
    const lines = [TITLE[p.unit]]
    if (b.uah) lines.push(`🇺🇦 ${two(b.uah, 'UAH')}`)
    else if (p.uah !== null) lines.push(`🇺🇦 ${money(p.uah, 'UAH')} (НБУ)`)
    if (b.mdl) lines.push(`🇲🇩 ${two(b.mdl, 'MDL')}`)
    else if (p.mdl !== null) lines.push(`🇲🇩 ${money(p.mdl, 'MDL')} (${p.mdlBank === 'BNM' ? 'НБМ' : 'НБУ'})`)
    return lines.join('\n')
  })
  const banks = [pairs.some((p) => bank[p.unit].uah) && 'ПриватБанк', pairs.some((p) => bank[p.unit].mdl) && 'maib'].filter(Boolean)
  const head = `💱 Курс на ${dayLabel(live ? today : (date as string))}:${banks.length ? '\nПокупка → продажа' : ''}`
  return [head, ...blocks, ...(banks.length ? [`🏦 ${banks.join(' / ')}`] : [])].join('\n\n')
}
