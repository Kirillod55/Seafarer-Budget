import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { isTauri } from './runtime.ts'
import './styles.css'

// The desktop (Tauri) build ships its own assets; a service worker there would only get in the way.
if (!isTauri()) registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
