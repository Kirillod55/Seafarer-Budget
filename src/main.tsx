import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/onest'
import App from './App'
import { AppProvider } from './context.tsx'
import { db } from './db/local.ts'
import { watchLayout } from './desk/layout.ts'
import { isDemo } from './dev/is-demo.ts'
import { createUpdateGate } from './pwa-update.ts'
import { isTauri } from './runtime.ts'
import { Shell } from './Shell.tsx'
import { applyTextScale, applyTheme, loadTheme, watchSystemTheme } from './ui/theme.ts'
import './styles.css'
import './desk/desk.css'

// The desktop (Tauri) build ships its own assets; a service worker there would only get in the way.
if (!isTauri()) {
  // The record sheet (stage 2) sets data-editing="1" on <html> while it is open; until then this is always false.
  const gate = createUpdateGate({
    doc: document,
    isEditing: () => document.documentElement.dataset.editing === '1',
    apply: () => void updateSW(true),
  })
  const updateSW = registerSW({ immediate: true, onNeedRefresh: gate.onNeedRefresh })
}

applyTextScale()
watchLayout() // html.desk / html.desk-s by the window width, before the first paint
watchSystemTheme()
const root = createRoot(document.getElementById('root')!)

async function start(): Promise<void> {
  // Dev-only demo (#demo): the signed-in app on its own database, no Supabase. `import.meta.env.DEV` is false
  // in a production build, so this branch and the demo module it loads are left out of the bundle.
  if (import.meta.env.DEV && isDemo()) {
    const { demoDb, openDemo } = await import('./dev/demo-app.ts')
    const demo = demoDb()
    applyTheme(await loadTheme(demo))
    const app = await openDemo(demo)
    root.render(
      <StrictMode>
        <AppProvider value={app}>
          <Shell
            onSignOut={() => {
              location.hash = ''
              location.reload()
            }}
          />
        </AppProvider>
      </StrictMode>,
    )
    return
  }

  // The stored theme before the first paint of the app (default «Как в системе»).
  applyTheme(await loadTheme(db))
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
