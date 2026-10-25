import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { createUpdateGate } from './pwa-update.ts'
import { isTauri } from './runtime.ts'
import './styles.css'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
