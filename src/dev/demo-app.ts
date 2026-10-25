// Dev-only (loaded by main.tsx behind import.meta.env.DEV): the app services for the demo, without Supabase.
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { localDate } from '@shared/dates.ts'
import type { AppContextValue } from '../context.tsx'
import { createDb, type LocalDb } from '../db/local.ts'
import { createRepo } from '../db/repo.ts'
import type { Scheduler, SchedulerStatus } from '../db/scheduler.ts'
import { seedDemo } from './demo.ts'

export const DEMO_DB_NAME = 'seafarer-budget-demo'

export function demoDb(): LocalDb {
  return createDb(DEMO_DB_NAME)
}

/** Always «synced»: nothing to send anywhere. */
function demoScheduler(): Scheduler {
  const status: SchedulerStatus = { state: 'idle', lastSyncAt: Date.now(), error: null }
  return {
    kick: () => {},
    stop: () => {},
    status$: { get: () => status, subscribe: () => () => {} },
  }
}

/** Seeds the demo database on first open and returns the context for <AppProvider>. */
export async function openDemo(db: LocalDb): Promise<AppContextValue> {
  const now = () => new Date()
  await seedDemo(db, localDate(now(), DEFAULT_SETTINGS.timezone))
  const repo = createRepo(db, { now, uuid: () => crypto.randomUUID(), onChange: () => {} })
  return { db, repo, scheduler: demoScheduler(), now }
}
