// The rates message: /currency in the bot and the 08:00 message from the keepalive function. No npm imports.
// Buy / sell from real banks (bankRates.ts); a source that is down falls back to the official rate, marked as such.
import { noBankRates, type BankRates, type BuySell } from './bankRates.ts'
import { money } from './format.ts'
import { currentRates } from './fx.ts'
import type { FxRate } from './types.ts'

const two = (v: BuySell, cur: string) => `${money(v.buy, cur)} / ${money(v.sell, cur)}`

export function ratesText(rates: FxRate[], today: string, dayLabel: (date: string) => string, bank: BankRates = noBankRates()): string {
  const { date, pairs } = currentRates(rates, today)
  const live = pairs.some((p) => bank[p.unit].uah || bank[p.unit].mdl)
  if (!date && !live) return 'Курсов пока нет — попробуй позже'
  const lines: string[] = []
  for (const p of pairs) {
    const unit = money(1, p.unit, { whole: true })
    const b = bank[p.unit]
    if (b.uah) lines.push(`${unit} = ${two(b.uah, 'UAH')}`)
    else if (p.uah !== null) lines.push(`${unit} = ${money(p.uah, 'UAH')} (НБУ)`)
    if (b.mdl) lines.push(`${unit} = ${two(b.mdl, 'MDL')}`)
    else if (p.mdl !== null) lines.push(`${unit} = ${money(p.mdl, 'MDL')} (${p.mdlBank === 'BNM' ? 'НБМ' : 'НБУ'})`)
  }
  const sources = [pairs.some((p) => bank[p.unit].uah) && 'гривна — ПриватБанк', pairs.some((p) => bank[p.unit].mdl) && 'лей — maib'].filter(Boolean)
  const head = `Курс на ${dayLabel(live ? today : (date as string))}${live ? ', покупка / продажа' : ''}:`
  return [head, ...lines, ...(sources.length ? [`${sources.join(', ').replace(/^./, (c) => c.toUpperCase())}`] : [])].join('\n')
}
