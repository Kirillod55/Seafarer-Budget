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

/** Month names for titles: «Октябрь 2026». */
export const MONTHS_NOM = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
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

/** Dative month names: «Наберётся к июлю 2035». */
export const MONTHS_DAT = [
  'январю',
  'февралю',
  'марту',
  'апрелю',
  'маю',
  'июню',
  'июлю',
  'августу',
  'сентябрю',
  'октябрю',
  'ноябрю',
  'декабрю',
]

/** Prepositional month names: «в сентябре». */
export const MONTHS_IN = [
  'январе',
  'феврале',
  'марте',
  'апреле',
  'мае',
  'июне',
  'июле',
  'августе',
  'сентябре',
  'октябре',
  'ноябре',
  'декабре',
]

/** 'YYYY-MM' moved by k months: shiftMonth('2026-01', -1) = '2025-12'. */
export function shiftMonth(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7)
}

/** «Октябрь 2026» */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_NOM[m - 1]} ${y}`
}

/** «1 запись», «2 записи», «5 записей» — and any other noun: plural(n, 'день', 'дня', 'дней'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${word}`
}
