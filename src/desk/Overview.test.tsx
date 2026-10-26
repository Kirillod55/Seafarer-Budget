import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Transaction } from '@shared/types.ts'
import { TEST_TODAY } from '../test-utils.tsx'
import { daySpend } from './Overview.tsx'
import { deskShell } from './test-desk.tsx'

const tx = (date: string, amount_usd: number, extra: Partial<Transaction> = {}) =>
  ({ kind: 'expense', date, amount_usd, author: 'owner', ...extra }) as Transaction

async function seeded() {
  const { env } = await deskShell('full', { partner_name: 'Маша' })
  const account = (await env.db.accounts.toCollection().first())!
  const cats = await env.db.categories.toArray()
  const add = (date: string, amount: number, category_id: string | null, author: 'owner' | 'partner' = 'owner') =>
    env.repo.addTransaction({
      kind: 'expense',
      amount,
      currency: 'USD',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id,
      date,
      note: '',
      source: 'app',
      author,
    })
  const food = cats.find((c) => c.kind === 'expense')!
  await add(TEST_TODAY, 30, food.id)
  await add('2026-10-05', 10, food.id, 'partner')
  await env.repo.put('limits', { id: 'lim-1', deleted: false, category_id: food.id, monthly_usd: 40, deleted_at: null, deleted_batch: null })
  return { env, food }
}

describe('PC home «Обзор» (spec §11 «Главная — панель»)', () => {
  it('day sums are the calendar\'s: expenses only, archived included', () => {
    const m = daySpend(
      [tx('2026-10-05', 10), tx('2026-10-05', 5, { archived: true }), tx('2026-10-06', 7, { kind: 'income' }), tx('2026-09-30', 3)],
      '2026-10',
    )
    expect([...m.entries()]).toEqual([['2026-10-05', 15]])
  })

  it('month calendar: today outlined, future days disabled, a click opens the calendar on that day', async () => {
    await seeded()
    const cal = await screen.findByRole('region', { name: 'Календарь месяца' })
    const today = await within(cal).findByRole('button', { name: '21 октября: $30' })
    expect(today.className).toContain('today')
    expect(today.className).toContain('hot')
    expect((within(cal).getByRole('button', { name: '22 октября: без трат' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(await within(cal).findByRole('button', { name: '5 октября: $10' }))
    expect(await screen.findByRole('button', { name: 'Назад, Главная' })).toBeTruthy()
    // the calendar's day card is on the 5th
    await waitFor(() => expect(document.querySelector('.day.sel, .day[aria-pressed="true"]')?.textContent ?? '').toMatch(/^5/))
  })

  it('month: total, «Я / Маша» and the top categories as in the report', async () => {
    const { food } = await seeded()
    const month = await screen.findByRole('region', { name: 'Месяц' })
    await waitFor(() => expect(within(month).getByText('Расходы · $40')).toBeTruthy())
    expect(within(month).getByText('Я $30 · Маша $10')).toBeTruthy()
    expect(within(month).getByText(food.name)).toBeTruthy()
    fireEvent.click(within(month).getByRole('button', { name: 'Отчёт ›' }))
    expect(await screen.findByRole('heading', { level: 1, name: /Октябрь/ })).toBeTruthy()
  })

  it('limits: the bar turns red when over', async () => {
    await seeded()
    const lims = await screen.findByRole('region', { name: 'Лимиты' })
    await waitFor(() => expect(lims.querySelector('.olim')!.getAttribute('data-level')).toBe('over'))
    expect(lims.querySelector('.minibar.over')).toBeTruthy()
  })

  it('the phone home has no «Обзор»', async () => {
    await deskShell('phone')
    await screen.findByRole('button', { name: 'Новая запись' })
    expect(screen.queryByRole('complementary', { name: 'Обзор' })).toBeNull()
  })
})
