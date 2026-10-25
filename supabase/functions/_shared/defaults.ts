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
  reserve_usd: 0,
  partner_name: null,
  partner_seen_at: null,
  remind_after_days: 2,
  last_reminder_at: null,
  keepalive_at: null,
  daily_summary_owner: false,
  daily_summary_partner: false,
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
  ([name, kind, icon, keywords], sort) => ({
    name,
    kind,
    icon,
    keywords,
    archived: false,
    sort,
    color: null,
    glyph: null,
    deleted_at: null,
    deleted_batch: null,
  }),
)

/** Built-in colour and glyph key of the standard categories, by name. */
export const CATEGORY_STYLE: Record<string, { color: string; glyph: string }> = {
  'Продукты': { color: '#30B455', glyph: 'cart' },
  'Кафе и рестораны': { color: '#FF9500', glyph: 'coffee' },
  'Транспорт и такси': { color: '#0A84FF', glyph: 'car' },
  'Жильё и коммуналка': { color: '#AF52DE', glyph: 'home' },
  'Связь и интернет': { color: '#32ADE6', glyph: 'wifi' },
  'Здоровье': { color: '#FF3B30', glyph: 'health' },
  'Развлечения': { color: '#FF2D55', glyph: 'ticket' },
  'Документы и курсы': { color: '#8E8E93', glyph: 'doc' },
  'Прочее': { color: '#8E8E93', glyph: 'box' },
  'Одежда': { color: '#5856D6', glyph: 'shirt' },
  'Подарки': { color: '#FF2D55', glyph: 'gift' },
  'Путешествия': { color: '#0A84FF', glyph: 'plane' },
  'Авто': { color: '#FF9500', glyph: 'fuel' },
  'Зарплата': { color: '#30B455', glyph: 'wallet' },
  'Прочий доход': { color: '#30B455', glyph: 'wallet' },
}

const FALLBACK_STYLE = { color: '#8E8E93', glyph: 'tag' }

/** The category's own colour/glyph, else the built-in one for its name, else grey with a tag. */
export function categoryStyle(c: Category): { color: string; glyph: string } {
  const builtIn = CATEGORY_STYLE[c.name] ?? FALLBACK_STYLE
  return { color: c.color ?? builtIn.color, glyph: c.glyph ?? builtIn.glyph }
}

export const CURRENCY_SYMBOL: Record<string, string> = {
  UAH: '₴',
  USD: '$',
  EUR: '€',
  MDL: 'L',
}
