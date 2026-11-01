// The rates message: /currency in the bot and the 08:00 message from the keepalive function. No npm imports.
import { money } from './format.ts'
import { currentRates } from './fx.ts'
import type { FxRate } from './types.ts'

export function ratesText(rates: FxRate[], today: string, dayLabel: (date: string) => string): string {
  const { date, pairs } = currentRates(rates, today)
  if (!date) return 'Курсов пока нет — попробуй позже'
  const lines = pairs.map((p) => {
    const parts = [p.uah !== null ? money(p.uah, 'UAH') : null, p.mdl !== null ? money(p.mdl, 'MDL') : null].filter(Boolean)
    return `${money(1, p.unit, { whole: true })} = ${parts.length ? parts.join(' · ') : 'курса нет'}`
  })
  return `Курс НБУ на ${dayLabel(date)}:\n${lines.join('\n')}`
}
