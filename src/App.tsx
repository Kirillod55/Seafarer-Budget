import { useEffect, useState } from 'react'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { Authed } from './Authed.tsx'
import { Login } from './screens/Login.tsx'
import { supabase } from './supabase.ts'

const NO_CONNECTION = 'Нет связи с сервером, попробуйте позже'
const BAD_CREDENTIALS = 'Не удалось войти: проверьте почту и пароль'

/** supabase-js keeps the session under `sb-<project-ref>-auth-token`; it survives an expired access token. */
export function hasStoredSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && /^sb-.+-auth-token$/.test(key)) return true
    }
  } catch {
    // storage unavailable (private mode etc.): nothing stored
  }
  return false
}

function clearStoredSession(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && /^sb-.+-auth-token$/.test(key)) localStorage.removeItem(key)
    }
  } catch {
    // nothing to clear
  }
}

/** A failure to reach the server (offline, DNS, timeout) rather than a server answer. */
export function isNetworkError(e: unknown): boolean {
  if (isAuthRetryableFetchError(e)) return true
  if (e instanceof TypeError) return true // fetch() rejects with TypeError when there is no network
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /failed to fetch|network|load failed|fetch failed|timeout/i.test(msg)
}

// 'checking' = reading the stored session, 'in' = signed in (maybe offline), 'out' = signed out
type AuthState = 'checking' | 'in' | 'out'

export default function App() {
  const [auth, setAuth] = useState<AuthState>(supabase ? 'checking' : 'out')

  useEffect(() => {
    if (!supabase) return
    let alive = true
    const set = (s: AuthState) => alive && setAuth(s)
    // Offline with an expired access token getSession() answers { session: null, error: AuthRetryableFetchError }
    // while the session is still in storage: that is "signed in, offline", not "signed out".
    // Auto-refresh emits TOKEN_REFRESHED once the network is back.
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (data.session) set('in')
        else if ((error && isNetworkError(error)) || hasStoredSession()) set('in')
        else set('out')
      })
      .catch(() => set(hasStoredSession() ? 'in' : 'out'))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') set('out')
      else if (s) set('in')
      else if (!hasStoredSession()) set('out')
      // null session with a stored one (INITIAL_SESSION offline): keep the current state
    })
    return () => {
      alive = false
      data.subscription.unsubscribe()
    }
  }, [])

  if (!supabase) {
    return (
      <main className="page narrow">
        <h1>Seafarer Budget</h1>
        <p className="error">Не настроено подключение к Supabase (VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY).</p>
      </main>
    )
  }
  const client = supabase

  if (auth === 'checking') return <p className="splash muted">Загрузка…</p>
  if (auth === 'out') {
    return (
      <Login
        onLogin={async (email, password) => {
          try {
            const { error } = await client.auth.signInWithPassword({ email, password })
            if (!error) return null
            return isNetworkError(error) ? NO_CONNECTION : BAD_CREDENTIALS
          } catch (e) {
            return isNetworkError(e) ? NO_CONNECTION : BAD_CREDENTIALS
          }
        }}
      />
    )
  }
  return (
    <Authed
      client={client}
      onSignOut={() => {
        void client.auth
          .signOut()
          .catch(() => undefined)
          // offline with an expired token supabase-js keeps the stored session: drop it so a reload stays signed out
          .then(() => {
            clearStoredSession()
            setAuth('out')
          })
      }}
    />
  )
}
