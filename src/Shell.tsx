import { DeskKeys } from './desk/DeskKeys.tsx'
import { UpdateToast } from './desk/UpdateToast.tsx'
import { appUpdater } from './desk/updater.ts'
import { Sidebar, activeItem, routeOf } from './desk/Sidebar.tsx'
import { Navigator, type Route } from './nav/Navigator.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Archive } from './screens/Archive.tsx'
import { Calendar } from './screens/Calendar.tsx'
import { Categories } from './screens/Categories.tsx'
import { Goals } from './screens/Goals.tsx'
import { Home } from './screens/Home.tsx'
import { Limits } from './screens/Limits.tsx'
import { More } from './screens/More.tsx'
import { RecordSheetHost, useRecordSheet } from './screens/RecordSheet.tsx'
import { Records } from './screens/Records.tsx'
import { Report } from './screens/Report.tsx'
import { ToastHost } from './ui/Toast.tsx'

/*
 * The signed-in app: the four-tab navigator with the screens in it. Stage 2 replaces the 1.0 screens one by one;
 * until then they sit inside the new navigation. The record sheet is one for the whole app: RecordSheetHost around
 * the navigator, screens open it with useRecordSheet().openRecord(id?).
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
        if (route.tab === 'goals') return <Goals />
        return <More onSignOut={onSignOut} />
      case 'limits':
        return <Limits />
      case 'accounts':
        return <Accounts />
      case 'cats':
        return <Categories />
      case 'archive':
        return <Archive />
      case 'calendar':
        return <Calendar />
      case 'records':
        return <Records />
    }
  }

  return (
    <>
      <Navigator
        renderScreen={renderScreen}
        onNavigate={closeRecord}
        sidebar={(route, open) => (
          <>
            <Sidebar
              current={activeItem(route)}
              onOpen={(item, part) => {
                open(routeOf(item))
                if (part) scrollToCard('Второй человек в боте')
              }}
            />
            <DeskKeys />
          </>
        )}
      />
      {/* the one toast host: screens call useToast() */}
      <ToastHost />
      <UpdateToast updater={appUpdater()} />
    </>
  )
}


/** After opening «Настройки»: bring a group into view once the screen has read its data. */
function scrollToCard(title: string) {
  let tries = 0
  const find = () => {
    const h = [...document.querySelectorAll('.screen:not(.below) h3')].find((el) => el.textContent === title)
    if (h) h.closest('section')?.scrollIntoView?.({ block: 'start' })
    else if (++tries < 40) setTimeout(find, 25)
  }
  setTimeout(find, 0)
}
