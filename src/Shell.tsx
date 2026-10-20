import { useState } from 'react'
import { SyncBadge } from './components/SyncBadge.tsx'
import { Home } from './screens/Home.tsx'

export type Screen = 'home' | 'record' | 'report' | 'goals' | 'limits' | 'accounts' | 'settings'

const NAV: { id: Screen; icon: string; label: string }[] = [
  { id: 'home', icon: '🏠', label: 'Главная' },
  { id: 'record', icon: '✏️', label: 'Запись' },
  { id: 'report', icon: '📊', label: 'Отчёт' },
  { id: 'goals', icon: '🎯', label: 'Цели' },
  { id: 'limits', icon: '🚦', label: 'Лимиты' },
  { id: 'accounts', icon: '💳', label: 'Счета' },
  { id: 'settings', icon: '⚙️', label: 'Ещё' },
]

function Soon({ title }: { title: string }) {
  return (
    <section className="card center">
      <h2>{title}</h2>
      <p className="muted">Скоро</p>
    </section>
  )
}

export function Shell({ onSignOut }: { onSignOut(): void }) {
  const [screen, setScreen] = useState<Screen>('home')

  return (
    <div className="shell">
      <header className="topbar">
        <SyncBadge />
        <button type="button" className="btn btn-link" onClick={onSignOut}>
          Выйти
        </button>
      </header>
      <main className="page">
        {screen === 'home' ? <Home /> : <Soon title={NAV.find((n) => n.id === screen)!.label} />}
      </main>
      <nav className="tabbar" aria-label="Разделы">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`tab${screen === n.id ? ' active' : ''}`}
            aria-current={screen === n.id ? 'page' : undefined}
            onClick={() => setScreen(n.id)}
          >
            <span className="tab-icon" aria-hidden="true">
              {n.icon}
            </span>
            <span className="tab-label">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
