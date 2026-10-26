import type { CSSProperties } from 'react'
import { NavBar } from './nav/NavBar.tsx'
import { Navigator, useNav, type Route } from './nav/Navigator.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Calendar } from './screens/Calendar.tsx'
import { Goals } from './screens/Goals.tsx'
import { Home } from './screens/Home.tsx'
import { Limits } from './screens/Limits.tsx'
import { RecordSheetHost, useRecordSheet } from './screens/RecordSheet.tsx'
import { Records } from './screens/Records.tsx'
import { Report } from './screens/Report.tsx'
import { Settings } from './screens/Settings.tsx'
import { Archive, ChevronRight, CreditCard, Gauge, Tag, type LucideIcon } from './ui/icons.ts'
import { ToastHost } from './ui/Toast.tsx'

/*
 * The signed-in app: the four-tab navigator with the screens in it. Stage 2 replaces the 1.0 screens one by one;
 * until then they sit inside the new navigation («Категории» and «Архив» are placeholders — Tasks 11/12; «Ещё» is
 * redone in Task 10). The record sheet is one for the whole app: RecordSheetHost around the navigator, screens open
 * it with useRecordSheet().openRecord(id?).
 */
export function Shell({ onSignOut }: { onSignOut(): void }) {
  return (
    <RecordSheetHost>
      <ShellNav onSignOut={onSignOut} />
    </RecordSheetHost>
  )
}

function ShellNav({ onSignOut }: { onSignOut(): void }) {
  // any navigation closes an open record sheet (as «Отмена»)
  const { closeRecord } = useRecordSheet()

  const renderScreen = (route: Route) => {
    switch (route.screen) {
      case 'root':
        if (route.tab === 'home') return <Home />
        if (route.tab === 'report') return <Report />
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
        return <Calendar />
      case 'records':
        return <Records />
    }
  }

  return (
    <>
      <Navigator renderScreen={renderScreen} onNavigate={closeRecord} />
      {/* the one toast host: screens call useToast() */}
      <ToastHost />
    </>
  )
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
