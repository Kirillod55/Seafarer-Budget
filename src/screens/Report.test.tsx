import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FxRate } from '@shared/types.ts'
import { Report } from './Report.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// Recharts' ResponsiveContainer has zero size in jsdom: stand in for the chart and expose its data.
vi.mock('../components/SpendPie.tsx', () => ({
  SpendPie: ({ data }: { data: { name: string; value: number }[] }) => <div data-testid="pie">{data.length}</div>,
}))

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let accountId: string
const cat: Record<string, string> = {}

async function expense(amount: number, currency: string, date: string, category: string | null, note = '') {
  await env.repo.addTransaction({
    kind: 'expense',
    amount,
    currency,
    account_id: accountId,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: category ? cat[category] : null,
    date,
    note,
    source: 'app',
  })
}

/** October 2026 expenses total $480; per category: Продукты 300, Транспорт 100, без категории 50 (2000 UAH), Кафе 30. */
async function seedOctober() {
  await expense(200, 'USD', '2026-10-02', 'Продукты')
  await expense(100, 'USD', '2026-10-09', 'Продукты')
  await expense(100, 'USD', '2026-10-05', 'Транспорт и такси')
  await expense(2000, 'UAH', '2026-10-12', null, 'наличные')
  await expense(20, 'USD', '2026-10-15', 'Кафе и рестораны')
  await expense(10, 'USD', '2026-10-16', 'Кафе и рестораны')
}

beforeEach(async () => {
  env = makeEnv()
  await env.repo.initDefaults('single', [{ currency: 'USD', amount: 100 }])
  await env.db.fx_rates.bulkPut([rate('2026-10-01', 'UAH', 1), rate('2026-10-01', 'USD', 40)] as FxRate[])
  accountId = (await env.db.accounts.toCollection().first())!.id
  for (const c of await env.db.categories.toArray()) cat[c.name] = c.id
})

describe('Report', () => {
  it('lists categories by descending spend with USD amounts and shares, «Без категории» included', async () => {
    await seedOctober()
    renderWithApp(<Report />, env)

    expect(await screen.findByText('Октябрь 2026')).toBeTruthy()
    const list = await screen.findByRole('list', { name: 'Категории' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Продукты'),
      expect.stringContaining('Транспорт и такси'),
      expect.stringContaining('Без категории'),
      expect.stringContaining('Кафе и рестораны'),
    ])
    expect(rows[0].textContent).toContain('$300')
    expect(rows[0].textContent).toContain('63%')
    expect(rows[1].textContent).toContain('$100')
    expect(rows[1].textContent).toContain('21%')
    expect(rows[2].textContent).toContain('$50')
    expect(rows[2].textContent).toContain('10%')
    expect(rows[3].textContent).toContain('$30')
    expect(rows[3].textContent).toContain('6%')
    expect(screen.getByText('$480')).toBeTruthy() // month total
    expect(screen.getByTestId('pie').textContent).toBe('4')
  })

  it('says «на 20% больше, чем в сентябре» when spending grew', async () => {
    await seedOctober()
    await expense(400, 'USD', '2026-09-20', 'Продукты')
    renderWithApp(<Report />, env)
    expect(await screen.findByText('на 20% больше, чем в сентябре')).toBeTruthy()
  })

  it('says «на 20% меньше, чем в сентябре» when spending fell', async () => {
    await seedOctober()
    await expense(600, 'USD', '2026-09-20', 'Продукты')
    renderWithApp(<Report />, env)
    expect(await screen.findByText('на 20% меньше, чем в сентябре')).toBeTruthy()
  })

  it('says «В сентябре трат не было» when the previous month is empty', async () => {
    await seedOctober()
    renderWithApp(<Report />, env)
    expect(await screen.findByText('В сентябре трат не было')).toBeTruthy()
    expect(screen.queryByText(/больше, чем|меньше, чем/)).toBeNull()
  })

  it('top-5 shows date, category, original amount and USD, largest first, and drops the 6th', async () => {
    await seedOctober()
    renderWithApp(<Report />, env)

    const top = await screen.findByRole('list', { name: 'Топ расходов' })
    const rows = within(top).getAllByRole('listitem')
    expect(rows).toHaveLength(5)
    expect(rows[0].textContent).toContain('02.10')
    expect(rows[0].textContent).toContain('Продукты')
    expect(rows[0].textContent).toContain('$200')
    // 2000 UAH is the 4th largest ($50): original currency plus USD
    expect(rows[3].textContent).toContain('12.10')
    expect(rows[3].textContent).toContain('Без категории')
    expect(rows[3].textContent).toContain('₴2,000')
    expect(rows[3].textContent).toContain('$50')
    expect(within(top).queryByText(/16\.10/)).toBeNull() // the $10 cafe expense is 6th
  })

  it('arrows switch the month; the next arrow is disabled in the current month', async () => {
    await seedOctober()
    await expense(250, 'USD', '2026-09-20', 'Продукты')
    renderWithApp(<Report />, env)

    await screen.findByText('Октябрь 2026')
    const next = screen.getByRole('button', { name: 'Следующий месяц' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Предыдущий месяц' }))
    expect(await screen.findByText('Сентябрь 2026')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Категории' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('$250')).toBeTruthy()
    expect(screen.getByText('В августе трат не было')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Следующий месяц' }))
    expect(await screen.findByText('Октябрь 2026')).toBeTruthy()
  })

  it('an empty month says there were no expenses instead of drawing a chart', async () => {
    renderWithApp(<Report />, env)
    expect(await screen.findByText('Трат в этом месяце нет')).toBeTruthy()
    expect(screen.queryByTestId('pie')).toBeNull()
  })
})
