import type { Category, Settings } from './types.ts'

export const DEFAULT_SETTINGS: Omit<Settings, 'id' | 'deleted'> = {
  base_currency: 'USD',
  default_currency: 'UAH',
  currencies: ['UAH', 'USD', 'EUR', 'MDL'],
  accounts_mode: 'single',
  status: 'home',
  next_contract_date: null,
  contract_start_date: null,
  contract_end_date: null,
  salary_lag_days: 30,
  timezone: 'Europe/Kyiv',
}

type DefaultCategory = [name: string, kind: 'expense' | 'income', icon: string, keywords: string[]]

const RAW_CATEGORIES: DefaultCategory[] = [
  ['Продукты', 'expense', '🛒', ['продукт', 'атб', 'сильпо', 'магазин', 'еда']],
  ['Кафе и рестораны', 'expense', '☕', ['кофе', 'кафе', 'обед', 'ужин', 'ресторан', 'бар']],
  ['Транспорт и такси', 'expense', '🚕', ['такси', 'uber', 'bolt', 'автобус', 'метро', 'бензин', 'поезд']],
  ['Жильё и коммуналка', 'expense', '🏠', ['квартира', 'аренда', 'коммуналка', 'свет', 'газ', 'вода']],
  ['Связь и интернет', 'expense', '📱', ['связь', 'интернет', 'телефон', 'мобильный']],
  ['Здоровье', 'expense', '💊', ['аптека', 'врач', 'лекарства']],
  ['Одежда', 'expense', '👕', ['одежда', 'обувь']],
  ['Развлечения', 'expense', '🎬', ['кино', 'игры', 'подписка']],
  ['Подарки', 'expense', '🎁', ['подарок']],
  ['Путешествия', 'expense', '✈️', ['отель', 'билет', 'самолет']],
  ['Авто', 'expense', '🚗', ['авто', 'мойка', 'шиномонтаж', 'шины']],
  ['Документы и курсы', 'expense', '📄', ['курс', 'медкомиссия', 'виза', 'документы']],
  ['Прочее', 'expense', '📦', []],
  ['Зарплата', 'income', '💰', ['зп', 'зарплата']],
  ['Прочий доход', 'income', '➕', ['доход']],
]

export const DEFAULT_CATEGORIES: Omit<Category, 'id' | 'deleted'>[] = RAW_CATEGORIES.map(
  ([name, kind, icon, keywords], sort) => ({ name, kind, icon, keywords, archived: false, sort }),
)

export const CURRENCY_SYMBOL: Record<string, string> = {
  UAH: '₴',
  USD: '$',
  EUR: '€',
  MDL: 'L',
}
