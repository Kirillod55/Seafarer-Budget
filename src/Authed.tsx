import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppProvider, type AppContextValue } from './context.tsx'
import { db } from './db/local.ts'
import { createRepo } from './db/repo.ts'
import { createSupabaseRemote } from './db/remote-supabase.ts'
import { startScheduler } from './db/scheduler.ts'
import { createSync } from './db/sync.ts'
import { FirstRunGate } from './screens/FirstRunGate.tsx'
import { Shell } from './Shell.tsx'

const DEBOUNCE_MS = 2000
const POLL_MS = 60_000

interface Services {
  app: AppContextValue
  syncOnce: () => Promise<{ error?: string }>
}

/** Everything that exists only while someone is signed in (also offline, with a stored session). */
export function Authed({ client, onSignOut }: { client: SupabaseClient; onSignOut(): void }) {
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
