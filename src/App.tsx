import { useEffect, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { AppProvider, type AppContextValue } from './context.tsx'
import { db } from './db/local.ts'
import { createRepo } from './db/repo.ts'
import { createSupabaseRemote } from './db/remote-supabase.ts'
import { startScheduler } from './db/scheduler.ts'
import { createSync } from './db/sync.ts'
import { Login } from './screens/Login.tsx'
import { FirstRunGate } from './screens/FirstRunGate.tsx'
import { Shell } from './Shell.tsx'
import { supabase } from './supabase.ts'

const DEBOUNCE_MS = 2000
const POLL_MS = 60_000

interface Services {
  app: AppContextValue
  syncOnce: () => Promise<{ error?: string }>
}

/** Everything that exists only while someone is signed in. */
function Authed({ client, onSignOut }: { client: SupabaseClient; onSignOut(): void }) {
  const [services, setServices] = useState<Services | null>(null)

  useEffect(() => {
    const remote = createSupabaseRemote(client)
    const sync = createSync(db, remote)
    const scheduler = startScheduler(sync, { debounceMs: DEBOUNCE_MS, pollMs: POLL_MS, subscribe: remote.subscribe })
    const repo = createRepo(db, { now: () => new Date(), uuid: () => crypto.randomUUID(), onChange: scheduler.kick })
    setServices({ app: { db, repo, scheduler, now: () => new Date() }, syncOnce: sync.syncOnce })
    return () => {
      scheduler.stop()
      setServices(null)
    }
  }, [client])

  if (!services) return <p className="splash muted">Загрузка…</p>
  return (
    <AppProvider value={services.app}>
      <FirstRunGate syncOnce={services.syncOnce}>
        <Shell onSignOut={onSignOut} />
      </FirstRunGate>
    </AppProvider>
  )
}

export default function App() {
  // undefined = still checking the stored session, null = signed out
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!supabase) {
    return (
      <main className="page narrow">
        <h1>Seafarer Budget</h1>
        <p className="error">Не настроено подключение к Supabase (VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY).</p>
      </main>
    )
  }
  const client = supabase

  if (session === undefined) return <p className="splash muted">Загрузка…</p>
  if (!session) {
    return (
      <Login
        onLogin={async (email, password) => {
          const { error } = await client.auth.signInWithPassword({ email, password })
          return error ? 'Не удалось войти: проверьте почту и пароль' : null
        }}
      />
    )
  }
  return <Authed client={client} onSignOut={() => void client.auth.signOut()} />
}
