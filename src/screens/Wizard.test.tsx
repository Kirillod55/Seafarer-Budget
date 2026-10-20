import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Wizard } from './Wizard.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'

describe('Wizard', () => {
  it('single balance: «Один баланс», 5000 ₴, «Готово» → initDefaults("single", [UAH 5000])', async () => {
    const env = makeEnv()
    const initDefaults = vi.spyOn(env.repo, 'initDefaults').mockResolvedValue(undefined)
    const onDone = vi.fn()
    renderWithApp(<Wizard onDone={onDone} />, env)

    fireEvent.click(screen.getByRole('button', { name: 'Один баланс' }))
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))

    await waitFor(() => expect(initDefaults).toHaveBeenCalledTimes(1))
    expect(initDefaults).toHaveBeenCalledWith('single', [{ currency: 'UAH', amount: 5000 }])
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('does not finish before a mode is chosen', () => {
    const env = makeEnv()
    const initDefaults = vi.spyOn(env.repo, 'initDefaults').mockResolvedValue(undefined)
    renderWithApp(<Wizard onDone={vi.fn()} />, env)
    expect(screen.queryByRole('button', { name: 'Готово' })).toBeNull()
    expect(initDefaults).not.toHaveBeenCalled()
  })

  it('multi accounts: sends one opening entry per account with its name', async () => {
    const env = makeEnv()
    const initDefaults = vi.spyOn(env.repo, 'initDefaults').mockResolvedValue(undefined)
    renderWithApp(<Wizard onDone={vi.fn()} />, env)

    fireEvent.click(screen.getByRole('button', { name: 'Несколько счетов' }))
    fireEvent.change(screen.getByLabelText('Название счёта 1'), { target: { value: 'Карта' } })
    fireEvent.change(screen.getByLabelText('Сумма 1'), { target: { value: '1200,5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить счёт' }))
    fireEvent.change(screen.getByLabelText('Название счёта 2'), { target: { value: 'Наличные' } })
    fireEvent.change(screen.getByLabelText('Валюта 2'), { target: { value: 'USD' } })
    fireEvent.change(screen.getByLabelText('Сумма 2'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))

    await waitFor(() => expect(initDefaults).toHaveBeenCalledTimes(1))
    expect(initDefaults).toHaveBeenCalledWith('multi', [
      { currency: 'UAH', amount: 1200.5, accountName: 'Карта' },
      { currency: 'USD', amount: 300, accountName: 'Наличные' },
    ])
  })
})
