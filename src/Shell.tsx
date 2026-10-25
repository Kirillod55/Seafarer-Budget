import { Suspense, lazy, useState, type CSSProperties } from 'react'
import { SyncBadge } from './components/SyncBadge.tsx'
import { NavBar } from './nav/NavBar.tsx'
import { Navigator, useNav, type Route } from './nav/Navigator.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Goals } from './screens/Goals.tsx'
import { Home } from './screens/Home.tsx'
import { Limits } from './screens/Limits.tsx'
import { RecordScreen } from './screens/Record.tsx'
import { Settings } from './screens/Settings.tsx'
import { Archive, ChevronRight, CreditCard, Gauge, Tag, type LucideIcon } from './ui/icons.ts'

// The report pulls in the chart library, so it loads on demand (it is precached by the service worker).
const Report = lazy(() => import('./screens/Report.tsx').then((m) => ({ default: m.Report })))

/*
 * The signed-in app: the four-tab navigator with the screens in it. Stage 2 replaces the 1.0 screens one by one;
 * until then they sit inside the new navigation (the record form still opens in place of Home — Task 5 makes it
 * a sheet; «Категории» and «Архив» are placeholders — Tasks 11/12; «Ещё» is redone in Task 10).
 */
export function Shell({ onSignOut }: { onSignOut(): void }) {
  // the 1.0 record form, opened from Home's «+ Запись» or a tap on a record; any navigation drops it
  const [record, setRecord] = useState<{ id?: string } | null>(null)

  const renderScreen = (route: Route) => {
    switch (route.screen) {
      case 'root':
        if (route.tab === 'home')
          return (
            <>
              <header className="topbar">
                <SyncBadge />
              </header>
              {record ? (
                <RecordScreen id={record.id} onDone={() => setRecord(null)} />
              ) : (
                <Home onOpenRecord={(id) => setRecord({ id })} />
              )}
            </>
          )
        if (route.tab === 'report')
          return (
            <Suspense fallback={<p className="splash muted">Загрузка…</p>}>
              <div className="legacy-top">
                <Report />
              </div>
            </Suspense>
          )
        if (route.tab === 'goals')
          return (
            <div className="legacy-top">
              <Goals />
            </div>
          )
        return <More onSignOut={onSignOut} />
      case 'limits':
        return (
          <>
            <NavBar back={{ label: 'Ещё' }} title="Лимиты" />
            <div className="legacy-titled">
              <Limits />
            </div>
          </>
        )
      case 'accounts':
        return (
          <>
            <NavBar back={{ label: 'Ещё' }} title="Счета" />
            <div className="legacy-titled">
              <Accounts />
            </div>
          </>
        )
      case 'cats':
        return <Soon back="Ещё" title="Категории" />
      case 'archive':
        return <Soon back="Ещё" title="Архив" />
      case 'calendar':
        return <Soon back="Главная" title="Календарь" />
      case 'records':
        return <Soon back={route.from === 'cats' ? 'Категории' : 'Отчёт'} title="Расходы" />
    }
  }

  return <Navigator renderScreen={renderScreen} onNavigate={() => setRecord(null)} />
}

/** A screen that a later task builds. */
function Soon({ back, title }: { back: string; title: string }) {
  return (
    <>
      <NavBar back={{ label: back }} title={title} />
      <p className="muted">Скоро</p>
    </>
  )
}

const MENU: { screen: 'limits' | 'accounts' | 'cats' | 'archive'; label: string; icon: LucideIcon; color: string }[] = [
  { screen: 'limits', label: 'Лимиты', icon: Gauge, color: 'var(--act-arch)' },
  { screen: 'accounts', label: 'Счета', icon: CreditCard, color: 'var(--anchor)' },
  { screen: 'cats', label: 'Категории', icon: Tag, color: 'var(--accent-text)' },
  { screen: 'archive', label: 'Архив', icon: Archive, color: 'var(--act-edit)' },
]

/** «Ещё» for now: the menu of deeper screens, then the 1.0 settings (Task 10 redoes it). */
function More({ onSignOut }: { onSignOut(): void }) {
  const nav = useNav()
  return (
    <>
      <NavBar title="Ещё" />
      <div className="group menu">
        {MENU.map(({ screen, label, icon: Icon, color }) => (
          <button key={screen} type="button" onClick={() => nav.push({ tab: 'more', screen })}>
            <span className="ic" style={{ '--c': color } as CSSProperties} aria-hidden="true">
              <Icon strokeWidth={2} />
            </span>
            {label}
            <span className="chev" aria-hidden="true">
              <ChevronRight strokeWidth={2.2} />
            </span>
          </button>
        ))}
      </div>
      <Settings onSignOut={onSignOut} />
    </>
  )
}
