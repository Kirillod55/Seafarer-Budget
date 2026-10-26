import { useState, type FormEvent } from 'react'
import { Anchor } from '../ui/icons.ts'
import './record.css'
import './goals.css'
import './login.css'

/*
 * «Вход» (spec §6 «Все экраны переводятся на эту систему», «вход и мастер — проявление с лёгким масштабом»;
 * prototype login()): the lime anchor tile, «Seafarer Budget», a line on why to sign in, Email and Пароль, «Войти».
 * The sign-in itself is the caller's (App: supabase signInWithPassword) and unchanged: it gets the trimmed email and
 * the password and answers with an error text or null.
 */
export function Login({ onLogin }: { onLogin(email: string, password: string): Promise<string | null> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setError(await onLogin(email.trim(), password))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="login-col rec" onSubmit={submit}>
        <div className="login-logo" aria-hidden="true">
          <Anchor strokeWidth={2.2} />
        </div>
        <h1>Seafarer Budget</h1>
        <p className="muted">Войди, чтобы данные синхронизировались между телефоном, компьютером и ботом.</p>
        <div className="fld">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="inp"
            type="email"
            autoComplete="username"
            placeholder="name@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="fld">
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            className="inp"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="gerr" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-acc" disabled={busy}>
          Войти
        </button>
      </form>
    </main>
  )
}
