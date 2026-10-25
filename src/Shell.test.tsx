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

  it('tapping a transaction opens it for editing; «Удалить» → «Точно удалить?» returns home without it', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: /кофе/ }))
    expect(((await screen.findByLabelText('Сумма')) as HTMLInputElement).value).toBe('80')

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Точно удалить?' }))
    await waitFor(() => expect(screen.queryByText('кофе')).toBeNull())
    expect(await screen.findByRole('button', { name: '+ Запись' })).toBeTruthy()
  })

  it('has four tabs «Главная · Отчёт · Цели · Ещё» (no «Запись» tab); the sync state shows on «Главная»', async () => {
    await setup()
    const tabs = screen.getByRole('navigation', { name: 'Разделы' })
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Главная', 'Отчёт', 'Цели', 'Ещё'])
    expect(await screen.findByRole('status')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отчёт' }))
    expect(await screen.findByText('Октябрь 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Цели' }))
    expect(await screen.findByRole('heading', { name: 'Цели' })).toBeTruthy()
  })

  it('leaving «Главная» drops a half-filled record; coming back shows Home', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: '+ Запись' }))
    await screen.findByLabelText('Сумма')
    fireEvent.click(screen.getByRole('button', { name: 'Отчёт' }))
    fireEvent.click(screen.getByRole('button', { name: 'Главная' }))
    expect(await screen.findByRole('button', { name: '+ Запись' })).toBeTruthy()
    expect(screen.queryByLabelText('Сумма')).toBeNull()
  })

  it('«Ещё» rows open Лимиты, Счета, Категории and Архив under «‹ Ещё», which goes back', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    for (const name of ['Лимиты', 'Счета', 'Категории', 'Архив']) {
      fireEvent.click(await screen.findByRole('button', { name }))
      expect(await screen.findByRole('heading', { level: 1, name })).toBeTruthy()
      expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('Ещё')
      if (name === 'Категории' || name === 'Архив') expect(screen.getByText('Скоро')).toBeTruthy()
      const back = document.querySelector<HTMLButtonElement>('.navbar .navback')!
      expect(back.textContent).toBe('Ещё')
      fireEvent.click(back)
      expect(await screen.findByRole('heading', { level: 1, name: 'Ещё' })).toBeTruthy()
    }
  })

  it('the «Ещё» tab opens the settings, whose «Выйти» signs out', async () => {
    const env = makeEnv()
    await env.repo.initDefaults('single', [])
    const onSignOut = vi.fn()
    renderWithApp(<Shell onSignOut={onSignOut} />, env)

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
