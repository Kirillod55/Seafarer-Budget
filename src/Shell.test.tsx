import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from './test-utils.tsx'

// Recharts has no size in jsdom.
vi.mock('./components/SpendPie.tsx', () => ({ SpendPie: () => null }))

async function setup() {
  const env = makeEnv()
  await env.repo.initDefaults('single', [{ currency: 'USD', amount: 100 }])
  const account = (await env.db.accounts.toCollection().first())!
  const tx = await env.repo.addTransaction({
    kind: 'expense',
    amount: 80,
    currency: 'UAH',
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: null,
    date: TEST_TODAY,
    note: 'кофе',
    source: 'app',
  })
  renderWithApp(<Shell onSignOut={vi.fn()} />, env)
  return { env, tx }
}

describe('Shell navigation', () => {
  it('«+ Запись» on Home opens an empty form; «Отмена» returns home', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: '+ Запись' }))
    expect(((await screen.findByLabelText('Сумма')) as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(await screen.findByRole('button', { name: '+ Запись' })).toBeTruthy()
  })

  it('tapping a transaction opens it for editing; «Удалить» returns home without it', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: /кофе/ }))
    expect(((await screen.findByLabelText('Сумма')) as HTMLInputElement).value).toBe('80')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(screen.queryByText('кофе')).toBeNull())
    expect(await screen.findByRole('button', { name: '+ Запись' })).toBeTruthy()
  })

  it('the «Запись» and «Отчёт» tabs show the form and the report', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Запись' }))
    expect(await screen.findByLabelText('Сумма')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отчёт' }))
    expect(await screen.findByText('Октябрь 2026')).toBeTruthy()
  })
})
