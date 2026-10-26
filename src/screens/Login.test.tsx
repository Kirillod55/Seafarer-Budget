import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Login } from './Login.tsx'

describe('Вход', () => {
  it('the new look: the anchor tile, «Seafarer Budget», Email and Пароль, the lime «Войти»', () => {
    render(<Login onLogin={vi.fn()} />)
    expect(document.querySelector('.login .login-logo svg')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Seafarer Budget' })).toBeTruthy()
    const email = screen.getByLabelText('Email') as HTMLInputElement
    expect(email.type).toBe('email')
    expect(email.autocomplete).toBe('username')
    expect((screen.getByLabelText('Пароль') as HTMLInputElement).autocomplete).toBe('current-password')
    expect(screen.getByRole('button', { name: 'Войти' }).className).toContain('btn-acc')
  })

  it('submits the trimmed email and the password; the answer shows as an alert; busy while it works', async () => {
    let finish: (v: string | null) => void = () => {}
    const onLogin = vi.fn(() => new Promise<string | null>((r) => (finish = r)))
    render(<Login onLogin={onLogin} />)

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  kirill@example.com ' } })
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))

    expect(onLogin).toHaveBeenCalledWith('kirill@example.com', 'secret')
    await waitFor(() => expect((screen.getByRole('button', { name: 'Войти' }) as HTMLButtonElement).disabled).toBe(true))
    finish('Неверная почта или пароль')
    expect((await screen.findByRole('alert')).textContent).toBe('Неверная почта или пароль')
    expect((screen.getByRole('button', { name: 'Войти' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
