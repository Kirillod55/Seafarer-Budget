import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthRetryableFetchError, AuthApiError } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type AuthCb = (event: string, session: unknown) => void

const fake = vi.hoisted(() => {
  const state = {
    getSession: (async () => ({ data: { session: null }, error: null })) as () => Promise<unknown>,
    signIn: (async () => ({ data: {}, error: null })) as (c: unknown) => Promise<unknown>,
    listeners: [] as ((event: string, session: unknown) => void)[],
  }
  const client = {
    auth: {
      getSession: () => state.getSession(),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        state.listeners.push(cb)
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
      signInWithPassword: (c: unknown) => state.signIn(c),
      signOut: async () => ({ error: null }),
    },
  }
  return { state, client }
})

vi.mock('./supabase.ts', () => ({ supabase: fake.client }))
// The signed-in part (Dexie, sync, scheduler) is not under test here.
vi.mock('./Authed.tsx', () => ({
  Authed: ({ onSignOut }: { onSignOut(): void }) => (
    <button type="button" onClick={onSignOut}>
      SHELL
    </button>
  ),
}))

const TOKEN_KEY = 'sb-abcdefgh-auth-token'
const emit: AuthCb = (event, session) => {
  for (const l of fake.state.listeners) l(event, session)
}

beforeEach(() => {
  fake.state.listeners = []
  localStorage.clear()
})
afterEach(() => localStorage.clear())

describe('auth state (C1)', () => {
  it('offline cold start with an expired token and a stored session renders the shell, not Login', async () => {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: 'x', refresh_token: 'y' }))
    fake.state.getSession = async () => ({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    })
    render(<App />)
    act(() => emit('INITIAL_SESSION', null))
    expect(await screen.findByText('SHELL')).toBeTruthy()
    expect(screen.queryByLabelText('Пароль')).toBeNull()
  })

  it('a retryable error alone (no stored token visible) still keeps the user in', async () => {
    fake.state.getSession = async () => ({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    })
    render(<App />)
    expect(await screen.findByText('SHELL')).toBeTruthy()
  })

  it('getSession rejecting with a stored session still renders the shell', async () => {
    localStorage.setItem(TOKEN_KEY, '{}')
    fake.state.getSession = async () => {
      throw new TypeError('Failed to fetch')
    }
    render(<App />)
    expect(await screen.findByText('SHELL')).toBeTruthy()
  })

  it('explicit SIGNED_OUT shows Login even when the shell was up', async () => {
    localStorage.setItem(TOKEN_KEY, '{}')
    fake.state.getSession = async () => ({ data: { session: null }, error: new AuthRetryableFetchError('x', 0) })
    render(<App />)
    await screen.findByText('SHELL')
    localStorage.removeItem(TOKEN_KEY)
    act(() => emit('SIGNED_OUT', null))
    expect(await screen.findByLabelText('Пароль')).toBeTruthy()
    expect(screen.queryByText('SHELL')).toBeNull()
  })

  it('signing out offline drops the stored session and shows Login', async () => {
    localStorage.setItem(TOKEN_KEY, '{}')
    fake.state.getSession = async () => ({ data: { session: null }, error: new AuthRetryableFetchError('x', 0) })
    render(<App />)
    fireEvent.click(await screen.findByText('SHELL'))
    expect(await screen.findByLabelText('Пароль')).toBeTruthy()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('no stored session and no error shows Login', async () => {
    fake.state.getSession = async () => ({ data: { session: null }, error: null })
    render(<App />)
    act(() => emit('INITIAL_SESSION', null))
    expect(await screen.findByLabelText('Пароль')).toBeTruthy()
  })

  it('a valid session renders the shell', async () => {
    fake.state.getSession = async () => ({ data: { session: { access_token: 'a' } }, error: null })
    render(<App />)
    expect(await screen.findByText('SHELL')).toBeTruthy()
  })
})

describe('Login errors (C1)', () => {
  async function submit() {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Почта'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
  }

  it('a network failure says there is no connection', async () => {
    fake.state.getSession = async () => ({ data: { session: null }, error: null })
    fake.state.signIn = async () => ({ data: {}, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    await submit()
    expect((await screen.findByRole('alert')).textContent).toBe('Нет связи с сервером, попробуйте позже')
  })

  it('a thrown fetch error also says there is no connection', async () => {
    fake.state.getSession = async () => ({ data: { session: null }, error: null })
    fake.state.signIn = async () => {
      throw new TypeError('Failed to fetch')
    }
    await submit()
    expect((await screen.findByRole('alert')).textContent).toBe('Нет связи с сервером, попробуйте позже')
  })

  it('bad credentials say so', async () => {
    fake.state.getSession = async () => ({ data: { session: null }, error: null })
    fake.state.signIn = async () => ({ data: {}, error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials') })
    await submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Не удалось войти: проверьте почту и пароль'))
  })
})
