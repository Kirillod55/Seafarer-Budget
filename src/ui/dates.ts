// Dates in words for the interface (Russian): «21 октября», «вс, 20 декабря». Dates are 'YYYY-MM-DD' strings.

export const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

/** «21 октября» */
export function dayMonth(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS_GEN[m - 1]}`
}

/** The landing date under the balance (spec §3): «вс, 20 декабря» — short weekday, day, month in words. */
export function weekdayDayMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${WEEKDAYS_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${dayMonth(date)}`
}
