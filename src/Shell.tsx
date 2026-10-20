import { Suspense, lazy, useState } from 'react'
import { SyncBadge } from './components/SyncBadge.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Goals } from './screens/Goals.tsx'
import { Home } from './screens/Home.tsx'
import { Limits } from './screens/Limits.tsx'
import { RecordScreen } from './screens/Record.tsx'
import { Settings } from './screens/Settings.tsx'

// The report pulls in the chart library, so it loads on demand (it is precached by the service worker).
const Report = lazy(() => import('./screens/Report.tsx').then((m) => ({ default: m.Report })))

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

export function Shell({ onSignOut }: { onSignOut(): void }) {
  const [view, setView] = useState<{ screen: Screen; recordId?: string }>({ screen: 'home' })
  const { screen } = view
  const go = (next: Screen, recordId?: string) => setView({ screen: next, recordId })

  return (
    <div className="shell">
      <header className="topbar">
        <SyncBadge />
      </header>
      <main className="page">
        {screen === 'home' ? (
          <Home onOpenRecord={(id) => go('record', id)} />
        ) : screen === 'record' ? (
          <RecordScreen id={view.recordId} onDone={() => go('home')} />
        ) : screen === 'report' ? (
          <Suspense fallback={<p className="splash muted">Загрузка…</p>}>
            <Report />
          </Suspense>
        ) : screen === 'goals' ? (
          <Goals />
        ) : screen === 'limits' ? (
          <Limits />
        ) : screen === 'accounts' ? (
          <Accounts />
        ) : (
          <Settings onSignOut={onSignOut} />
        )}
      </main>
      <nav className="tabbar" aria-label="Разделы">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`tab${screen === n.id ? ' active' : ''}`}
            aria-current={screen === n.id ? 'page' : undefined}
            onClick={() => go(n.id)}
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
