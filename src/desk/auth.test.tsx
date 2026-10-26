import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Login } from '../screens/Login.tsx'
import { Wizard } from '../screens/Wizard.tsx'
import { renderWithApp } from '../test-utils.tsx'
import { applyLayout } from './layout.ts'

describe('PC sign-in and setup in two panes (spec §11)', () => {
  it('Вход: the app on the left, the form on the right; the eye shows the password; «Оставаться в системе» is passed', async () => {
    act(() => applyLayout('full'))
    const onLogin = vi.fn(async () => null)
    render(<Login onLogin={onLogin} />)
    expect(screen.getByText('Личный бюджет моряка — от рейса до посадки')).toBeTruthy()
    expect(screen.getByText('Траты вдвоём')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Вход' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
    const pass = screen.getByLabelText('Пароль') as HTMLInputElement
    expect(pass.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(pass.type).toBe('text')
    const remember = screen.getByRole('checkbox', { name: 'Оставаться в системе' }) as HTMLInputElement
    expect(remember.checked).toBe(true)
    fireEvent.click(remember)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' a@b.c ' } })
    fireEvent.change(pass, { target: { value: 'pw' } })
    fireEvent.submit(pass.closest('form')!)
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith('a@b.c', 'pw', false))
  })

  it('Мастер: the steps on the left mark the current one', async () => {
    act(() => applyLayout('icons'))
    renderWithApp(<Wizard onDone={vi.fn()} />)
    const steps = await screen.findByRole('list', { name: 'Шаги настройки' })
    const items = within(steps).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['1Режим счетов', '2Остаток', '3Посадка'])
    expect(items[0].getAttribute('aria-current')).toBe('step')
    fireEvent.click(await screen.findByRole('button', { name: 'Один баланс' }))
    await vi.waitFor(() => expect(items[1].getAttribute('aria-current')).toBe('step'))
    expect(items[0].className).toBe('done')
  })

  it('the phone keeps the one-column sign-in', () => {
    render(<Login onLogin={vi.fn(async () => null)} />)
    expect(screen.queryByText('Траты вдвоём')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Seafarer Budget' })).toBeTruthy()
  })
})
