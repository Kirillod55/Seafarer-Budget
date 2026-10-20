import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Category, FxRate, Limit } from '@shared/types.ts'
import { Limits } from './Limits.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let cafe: Category

async function seed() {
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 10000 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
}

/** An expense of `uah` hryvnia (= uah / 40 USD) in the cafe category on `date`. */
async function spend(uah: number, date = TEST_TODAY, categoryId: string | null = cafe.id) {
  const account = (await env.db.accounts.toCollection().first())!
  await env.repo.addTransaction({
    kind: 'expense',
    amount: uah,
    currency: 'UAH',
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: categoryId,
    date,
    note: '',
    source: 'app',
  })
}

const setLimit = (monthly_usd: number, category_id = cafe.id) =>
  env.repo.put<Limit>('limits', { category_id, monthly_usd })

beforeEach(() => {
  env = makeEnv()
})

describe('Limits', () => {
  it('«Задать лимит» Кафе $100 creates a limit and shows a bar with the month spending', async () => {
    await seed()
    await spend(3000) // $75
    renderWithApp(<Limits />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Задать лимит' }))
    fireEvent.change(await screen.findByLabelText('Категория'), { target: { value: cafe.id } })
    fireEvent.change(screen.getByLabelText('Лимит в месяц, $'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('$75 из $100')).toBeTruthy()
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(bar.getAttribute('data-level')).toBe('ok')
    expect(await env.db.limits.toArray()).toMatchObject([
      { category_id: cafe.id, monthly_usd: 100, deleted: false, dirty: 1 },
    ])
  })

  it.each([
    [3000, 'ok'], // 75 %
    [3200, 'warn'], // 80 %
    [4400, 'over'], // 110 %
  ])('spending %i ₴ of a $100 limit has level %s (class and data-level)', async (uah, level) => {
    await seed()
    await spend(uah)
    await setLimit(100)
    renderWithApp(<Limits />, env)

    const bar = await screen.findByRole('progressbar')
    expect(bar.getAttribute('data-level')).toBe(level)
    expect(bar.className).toContain(`level-${level}`)
  })

  it('only the current month counts, and a row per limited expense category is shown', async () => {
    await seed()
    await spend(4000, '2026-09-30') // last month
    await spend(400) // $10 this month
    await setLimit(100)
    renderWithApp(<Limits />, env)

    expect(await screen.findByText('$10 из $100')).toBeTruthy()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('«Задать лимит» offers only categories that have no limit yet', async () => {
    await seed()
    await setLimit(100)
    renderWithApp(<Limits />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Задать лимит' }))
    const select = (await screen.findByLabelText('Категория')) as HTMLSelectElement
    const names = [...select.options].map((o) => o.textContent ?? '')
    expect(names.some((n) => n.includes('Кафе и рестораны'))).toBe(false)
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => n.includes('Зарплата'))).toBe(false) // income categories never get a limit
  })

  it('a non-positive amount is rejected with «Введите сумму»', async () => {
    await seed()
    renderWithApp(<Limits />, env)
    fireEvent.click(await screen.findByRole('button', { name: 'Задать лимит' }))
    fireEvent.change(await screen.findByLabelText('Категория'), { target: { value: cafe.id } })
    fireEvent.change(screen.getByLabelText('Лимит в месяц, $'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await env.db.limits.count()).toBe(0)
  })

  it('tapping a row edits the monthly amount', async () => {
    await seed()
    const limit = await setLimit(100)
    renderWithApp(<Limits />, env)

    fireEvent.click(await screen.findByRole('button', { name: /Кафе и рестораны/ }))
    const amount = (await screen.findByLabelText('Лимит в месяц, $')) as HTMLInputElement
    expect(amount.value).toBe('100')
    fireEvent.change(amount, { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('$0 из $150')).toBeTruthy()
    expect(await env.db.limits.get(limit.id)).toMatchObject({ monthly_usd: 150, deleted: false, dirty: 1 })
    expect(await env.db.limits.count()).toBe(1)
  })

  it('«Убрать лимит» soft-deletes the limit and the row disappears', async () => {
    await seed()
    const limit = await setLimit(100)
    renderWithApp(<Limits />, env)

    fireEvent.click(await screen.findByRole('button', { name: /Кафе и рестораны/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Убрать лимит' }))

    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(await env.db.limits.get(limit.id)).toMatchObject({ deleted: true, dirty: 1 })
  })

  it('a removed limit can be set again for the same category without a duplicate row', async () => {
    await seed()
    const limit = await setLimit(100)
    await env.repo.remove('limits', limit.id)
    renderWithApp(<Limits />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Задать лимит' }))
    fireEvent.change(await screen.findByLabelText('Категория'), { target: { value: cafe.id } })
    fireEvent.change(screen.getByLabelText('Лимит в месяц, $'), { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('$0 из $80')).toBeTruthy()
    expect(await env.db.limits.toArray()).toMatchObject([{ id: limit.id, monthly_usd: 80, deleted: false }])
  })

  it('a limit on an archived category is not shown', async () => {
    await seed()
    await setLimit(100)
    await env.repo.put<Category>('categories', { ...cafe, archived: true })
    renderWithApp(<Limits />, env)

    await screen.findByRole('button', { name: 'Задать лимит' })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(within(document.body).queryByText(/Кафе и рестораны/)).toBeNull()
  })
})
