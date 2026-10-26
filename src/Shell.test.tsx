import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell.tsx'
import { useToast } from './ui/Toast.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from './test-utils.tsx'

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
  it('«+ Запись» on Home opens the empty record sheet over Home; «Отмена» closes it', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Новая запись' }))
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
    expect((screen.getByLabelText('Сумма') as HTMLInputElement).value).toBe('')
    expect(document.documentElement.dataset.editing).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.documentElement.dataset.editing).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Новая запись' })).toBeTruthy()
  })

  it('tapping a transaction opens it in the sheet; «Удалить запись» → «Удалить» removes it from Home', async () => {
    await setup()
    fireEvent.click(await screen.findByRole('button', { name: /кофе/i }))
    await waitFor(() => expect((screen.getByLabelText('Сумма') as HTMLInputElement).value).toBe('80'))

    fireEvent.click(screen.getByRole('button', { name: 'Удалить запись' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('button', { name: /кофе/i })).toBeNull())
    expect(await screen.findByText('Запись удалена')).toBeTruthy()
  })

  it('has four tabs «Главная · Отчёт · Цели · Ещё» (no «Запись» tab); the sync state shows on «Главная»', async () => {
    await setup()
    const tabs = screen.getByRole('navigation', { name: 'Разделы' })
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Главная', 'Отчёт', 'Цели', 'Ещё'])
    // the sync cloud sits in the home header
    await waitFor(() => expect(document.querySelector('.home-top .syncind[role="img"]')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Отчёт' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Цели' }))
    expect(await screen.findByRole('heading', { name: 'Цели' })).toBeTruthy()
  })

  it('a navigation closes an open record sheet without saving it', async () => {
    const { env } = await setup()
    const before = await env.db.transactions.count()
    fireEvent.click(await screen.findByRole('button', { name: 'Новая запись' }))
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отчёт' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await env.db.transactions.count()).toBe(before)
  })

  it('back from «Лимиты» shows the same, already loaded «Ещё» — no «Загрузка…» at any point', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    await screen.findByRole('button', { name: 'Выйти' })
    fireEvent.click(screen.getByRole('button', { name: 'Лимиты' }))
    await screen.findByRole('button', { name: 'Задать лимит' })

    let flashed = false
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes('Загрузка')) flashed = true
    })
    watch.observe(document.body, { subtree: true, childList: true, characterData: true })
    fireEvent.click(screen.getByRole('button', { name: 'Назад, Ещё' }))
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeTruthy() // there at once, not after a reload
    await new Promise((r) => setTimeout(r, 50))
    watch.disconnect()
    expect(flashed).toBe(false)
    expect(screen.queryByText(/Загрузка/)).toBeNull()
  })

  it('«Ещё» rows open Лимиты, Счета, Категории and Архив under «‹ Ещё», which goes back', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    for (const name of ['Лимиты', 'Счета', 'Категории', 'Архив']) {
      fireEvent.click(await screen.findByRole('button', { name }))
      expect(await screen.findByRole('heading', { level: 1, name })).toBeTruthy()
      expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('Ещё')
      if (name === 'Архив') expect(screen.getByText('Скоро')).toBeTruthy()
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

describe('Shell toast host', () => {
  it('a toast asked for anywhere in the app shows up (ToastHost is mounted once)', async () => {
    await setup()
    const { result } = renderHook(() => useToast())
    act(() => result.current('Запись удалена'))
    expect((await screen.findByText('Запись удалена')).closest('[role="status"]')).toBeTruthy()
  })
})
