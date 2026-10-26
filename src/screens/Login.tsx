import { useState, type FormEvent } from 'react'
import { AuthBrand } from '../desk/AuthBrand.tsx'
import { useDesk } from '../desk/layout.ts'
import { CalendarDays, Check, Eye, EyeOff, MonitorSmartphone, UsersRound } from '../ui/icons.ts'
import './record.css'
import './goals.css'
import './login.css'
import { AppLogo } from '../ui/AppLogo.tsx'

/*
 * «Вход» (spec §6 «Все экраны переводятся на эту систему», «вход и мастер — проявление с лёгким масштабом»;
 * prototype login()): the lime anchor tile, «Seafarer Budget», a line on why to sign in, Email and Пароль, «Войти».
 * The sign-in itself is the caller's (App: supabase signInWithPassword) and unchanged: it gets the trimmed email and
 * the password and answers with an error text or null.
 */
export function Login({
  onLogin,
}: {
  /** `remember` (PC «Оставаться в системе», on by default): false = forget the session when the window closes */
  onLogin(email: string, password: string, remember?: boolean): Promise<string | null>
}) {
  const desk = useDesk()
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(true)
  const [forgot, setForgot] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setError(await (desk ? onLogin(email.trim(), password, remember) : onLogin(email.trim(), password)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (desk) {
    // PC: two panes (spec §11): about the app on the left, the 400 px form on the right; the cursor starts in Email
    return (
      <div className="au">
        <AuthBrand>
          <ul className="au-feats">
            <li>
              <span className="au-fi" aria-hidden="true">
                <CalendarDays strokeWidth={2} />
              </span>
              <span>
                <b>Бюджет на день до посадки</b>
                <small>Сколько можно тратить сегодня, чтобы хватило до конца отпуска.</small>
              </span>
            </li>
            <li>
              <span className="au-fi" aria-hidden="true">
                <MonitorSmartphone strokeWidth={2} />
              </span>
              <span>
                <b>Телефон, компьютер и бот</b>
                <small>Записи синхронизируются везде, работают и без интернета.</small>
              </span>
            </li>
            <li>
              <span className="au-fi" aria-hidden="true">
                <UsersRound strokeWidth={2} />
              </span>
              <span>
                <b>Траты вдвоём</b>
                <small>Второй человек пишет траты боту — они видны в отчёте.</small>
              </span>
            </li>
          </ul>
        </AuthBrand>
        <main className="au-main">
          <div className="au-center">
            <form className="au-form rec" onSubmit={submit}>
              <h1 className="au-h">Вход</h1>
              <div className="fld">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  className="inp"
                  type="email"
                  autoComplete="username"
                  placeholder="name@example.com"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="fld">
                <label htmlFor="password">Пароль</label>
                <span className="au-pass">
                  <input
                    id="password"
                    className="inp"
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="au-eye"
                    aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                    title={show ? 'Скрыть пароль' : 'Показать пароль'}
                    onClick={() => setShow((v) => !v)}
                  >
                    {show ? <EyeOff aria-hidden="true" strokeWidth={2} /> : <Eye aria-hidden="true" strokeWidth={2} />}
                  </button>
                </span>
              </div>
              <label className="au-check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span className="au-box" aria-hidden="true">
                  <Check strokeWidth={3} />
                </span>
                Оставаться в системе
              </label>
              {error && (
                <p className="gerr" role="alert">
                  {error}
                </p>
              )}
              {forgot && (
                <p className="label" role="note">
                  Новый пароль задаётся в Supabase: Authentication → Users → Send password recovery.
                </p>
              )}
              <div className="au-actions">
                <button type="button" className="au-link" aria-expanded={forgot} onClick={() => setForgot((v) => !v)}>
                  Забыли пароль?
                </button>
                <button type="submit" className="fbtn primary" disabled={busy}>
                  Войти
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    )
  }

  return (
    <main className="login">
      <form className="login-col rec" onSubmit={submit}>
        <div className="login-logo" aria-hidden="true">
          <AppLogo />
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
