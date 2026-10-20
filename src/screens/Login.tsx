import { useState, type FormEvent } from 'react'

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
    <main className="page narrow">
      <h1>Seafarer Budget</h1>
      <p className="muted">Войдите, чтобы увидеть свой бюджет.</p>
      <form className="card stack" onSubmit={submit}>
        <label htmlFor="email">Почта</label>
        <input id="email" className="field" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Пароль</label>
        <input id="password" className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          Войти
        </button>
      </form>
    </main>
  )
}
