// Dev-only demo mode (`npx vite` → http://localhost:5173/#demo): the signed-in app on its own Dexie
// database filled with sample data, no Supabase. Nothing here reaches the production bundle:
// main.tsx calls isDemo() (is-demo.ts) behind `import.meta.env.DEV` and loads demo-app.ts dynamically.
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { addDays, daysBetween } from '@shared/dates.ts'
import { round2, usdRate } from '@shared/fx.ts'
import type { Account, Category, FxRate, Goal, GoalMove, Limit, Settings, Transaction } from '@shared/types.ts'
import type { LocalDb, Row } from '../db/local.ts'

/** Small deterministic PRNG (mulberry32): the demo looks the same on every open. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MAIN = 'demo-acc-main'
const CASH = 'demo-acc-cash'
const catId = (name: string) => `demo-cat-${DEFAULT_CATEGORIES.findIndex((c) => c.name === name)}`

/** Expense patterns: category, UAH range, notes. */
const SPEND: [category: string, min: number, max: number, notes: string[]][] = [
  ['Продукты', 180, 1400, ['АТБ', 'Сильпо', 'Рынок', 'Молоко и хлеб', '']],
  ['Кафе и рестораны', 70, 650, ['Кофе', 'Обед', 'Ужин с друзьями', 'Круассан', '']],
  ['Транспорт и такси', 40, 420, ['Такси', 'Bolt', 'Метро', 'Автобус']],
  ['Связь и интернет', 150, 450, ['Интернет', 'Мобильный']],
  ['Здоровье', 120, 900, ['Аптека', 'Витамины']],
  ['Развлечения', 100, 600, ['Кино', 'Подписка']],
  ['Одежда', 600, 3200, ['Кроссовки', 'Куртка']],
  ['Подарки', 300, 1500, ['Подарок маме', 'Цветы']],
  ['Авто', 400, 2200, ['Бензин', 'Мойка']],
  ['Прочее', 50, 500, ['Хозтовары', '']],
]
/** Weights of the patterns above: groceries and cafés every few days, clothes and gifts rarely. */
const WEIGHTS = [30, 22, 16, 3, 5, 5, 2, 2, 5, 10]

const LONG_NOTE =
  'Медкомиссия и продление сертификатов перед контрактом, оплата курсов в учебном центре'.slice(0, 80)

/**
 * Sample data for the demo (Review Focus 2 long values included): three calendar months of records up to
 * `today` (some by Маша, one archived, one in the bin), two goals (one archived, one for $1,234,567.89),
 * two limits, multi-account mode, landing date today + 59 and a $1,000 reserve. Does nothing when the
 * database already has settings, so the demo keeps the changes made while trying it.
 */
export async function seedDemo(db: LocalDb, today: string): Promise<void> {
  if ((await db.settings.count()) > 0) return
  const rnd = prng(20261025)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const between = (min: number, max: number) => Math.round(min + rnd() * (max - min))

  const [y, m] = today.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 10) // 1st of the month two months back

  // daily NBU-like rates (UAH per unit), so every record has an exact USD amount
  const rates: FxRate[] = []
  for (let d = start, i = 0; d <= today; d = addDays(d, 1), i++) {
    const usd = round2(41.2 + Math.sin(i / 9) * 0.35)
    rates.push(
      { date: d, currency: 'UAH', uah_per_unit: 1 },
      { date: d, currency: 'USD', uah_per_unit: usd },
      { date: d, currency: 'EUR', uah_per_unit: round2(usd * 1.08) },
      { date: d, currency: 'MDL', uah_per_unit: round2(usd / 17.6) },
    )
  }

  const settings: Row<Settings> = {
    ...DEFAULT_SETTINGS,
    id: 'demo-settings',
    deleted: false,
    accounts_mode: 'multi',
    status: 'home',
    next_contract_date: addDays(today, 59),
    reserve_usd: 1000,
    partner_name: 'Маша',
    partner_seen_at: `${addDays(today, -2)}T18:00:00.000Z`,
    dirty: 0,
  }

  const accounts: Row<Account>[] = [
    { id: MAIN, name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0, deleted: false, dirty: 0 },
    { id: CASH, name: 'Наличные', aliases: ['нал'], is_default: false, archived: false, sort: 1, deleted: false, dirty: 0 },
  ]

  const categories: Row<Category>[] = DEFAULT_CATEGORIES.map((c, i) => ({
    ...c,
    id: `demo-cat-${i}`,
    deleted: false,
    dirty: 0,
  }))

  let n = 0
  const txs: Row<Transaction>[] = []
  const add = (t: Partial<Transaction> & Pick<Transaction, 'kind' | 'amount' | 'currency' | 'date'>) => {
    const found = usdRate(rates, t.currency, t.date)!
    txs.push({
      id: `demo-tx-${++n}`,
      account_id: MAIN,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      note: '',
      source: 'app',
      author: 'owner',
      archived: false,
      deleted: false,
      deleted_at: null,
      deleted_batch: null,
      rate_usd: found.rate,
      amount_usd: round2(t.amount * found.rate),
      rate_pending: false,
      created_at: `${t.date}T${String(8 + (n % 12)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`,
      ...t,
      dirty: 0,
    })
    return txs[txs.length - 1]
  }

  // opening balances and income
  add({ kind: 'adjustment', amount: 182_000, currency: 'UAH', date: start, note: 'Начальный остаток' })
  add({ kind: 'adjustment', amount: 2_500, currency: 'USD', account_id: CASH, date: start, note: 'Начальный остаток' })
  add({ kind: 'adjustment', amount: 400, currency: 'EUR', account_id: CASH, date: start, note: 'Начальный остаток' })
  add({ kind: 'income', amount: 6_800, currency: 'USD', date: addDays(start, 4), category_id: catId('Зарплата'), note: 'Зарплата за рейс' })
  add({ kind: 'income', amount: 4_500, currency: 'UAH', date: addDays(start, 40), category_id: catId('Прочий доход'), note: 'Вернули долг' })
  add({
    kind: 'exchange',
    amount: 500,
    currency: 'USD',
    account_id: CASH,
    to_account_id: MAIN,
    to_amount: 20_550,
    to_currency: 'UAH',
    date: addDays(start, 20),
    note: 'Обмен в банке',
  })
  add({ kind: 'transfer', amount: 3_000, currency: 'UAH', to_account_id: CASH, date: addDays(start, 33), note: 'Снял наличные' })

  // everyday spending: 1–3 records a day, about a quarter of them by Маша (via the bot)
  const total = WEIGHTS.reduce((a, b) => a + b, 0)
  const pattern = () => {
    let r = rnd() * total
    for (let i = 0; i < WEIGHTS.length; i++) if ((r -= WEIGHTS[i]) < 0) return SPEND[i]
    return SPEND[0]
  }
  const days = daysBetween(start, today)
  for (let i = 0; i <= days; i++) {
    const date = addDays(start, i)
    const count = date === today ? 2 : 1 + Math.floor(rnd() * 3)
    for (let k = 0; k < count; k++) {
      const [category, min, max, notes] = pattern()
      const partner = rnd() < 0.25
      const eur = !partner && rnd() < 0.05
      add({
        kind: 'expense',
        amount: eur ? round2(between(min, max) / 45) : between(min, max),
        currency: eur ? 'EUR' : 'UAH',
        account_id: rnd() < 0.2 ? CASH : MAIN,
        category_id: catId(category),
        date,
        note: pick(notes),
        author: partner ? 'partner' : 'owner',
        source: partner ? 'bot' : 'app',
      })
    }
  }

  // the long values (Review Focus 2), one archived record and one in the bin
  add({
    kind: 'expense',
    amount: 4_850,
    currency: 'UAH',
    date: addDays(today, -3),
    category_id: catId('Документы и курсы'),
    note: LONG_NOTE,
  })
  add({
    kind: 'expense',
    amount: 2_400,
    currency: 'UAH',
    date: addDays(today, -12),
    category_id: catId('Подарки'),
    note: 'Сюрприз на годовщину',
    archived: true,
  })
  add({
    kind: 'expense',
    amount: 95,
    currency: 'UAH',
    date: today,
    category_id: catId('Кафе и рестораны'),
    note: 'Кофе с собой',
    deleted_at: `${today}T08:30:00.000Z`,
    deleted_batch: 'demo-bin-1',
  })

  const goals: Row<Goal>[] = [
    {
      id: 'demo-goal-house',
      name: 'Дом у моря для всей семьи',
      target_usd: 1_234_567.89,
      deadline: null,
      archived: false,
      deleted: false,
      deleted_at: null,
      deleted_batch: null,
      dirty: 0,
    },
    {
      id: 'demo-goal-phone',
      name: 'Новый телефон',
      target_usd: 1_200,
      deadline: addDays(start, 30),
      archived: true,
      deleted: false,
      deleted_at: null,
      deleted_batch: null,
      dirty: 0,
    },
  ]
  const move = (id: number, goal_id: string, amount_usd: number, date: string, author: GoalMove['author']): Row<GoalMove> => ({
    id: `demo-move-${id}`,
    goal_id,
    amount_usd,
    date,
    note: '',
    author,
    source: author === 'partner' ? 'bot' : 'app',
    created_at: `${date}T12:00:00.000Z`,
    deleted: false,
    dirty: 0,
  })
  const moves = [
    move(1, 'demo-goal-house', 1_500, addDays(start, 6), 'owner'),
    move(2, 'demo-goal-house', 250, addDays(start, 45), 'partner'),
    move(3, 'demo-goal-phone', 1_200, addDays(start, 10), 'owner'),
  ]

  const limits: Row<Limit>[] = [
    { id: 'demo-limit-cafe', category_id: catId('Кафе и рестораны'), monthly_usd: 150, deleted: false, deleted_at: null, deleted_batch: null, dirty: 0 },
    { id: 'demo-limit-food', category_id: catId('Продукты'), monthly_usd: 400, deleted: false, deleted_at: null, deleted_batch: null, dirty: 0 },
  ]

  await db.transaction('rw', [db.settings, db.accounts, db.categories, db.transactions, db.goals, db.goal_moves, db.limits, db.fx_rates], async () => {
    await db.fx_rates.bulkPut(rates)
    await db.accounts.bulkPut(accounts)
    await db.categories.bulkPut(categories)
    await db.transactions.bulkPut(txs)
    await db.goals.bulkPut(goals)
    await db.goal_moves.bulkPut(moves)
    await db.limits.bulkPut(limits)
    await db.settings.put(settings) // last: its presence means «seeded»
  })
}
