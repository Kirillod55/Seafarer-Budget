// Dev-only (loaded by main.tsx behind import.meta.env.DEV): the app services for the demo, without Supabase.
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { localDate } from '@shared/dates.ts'
import type { AppContextValue } from '../context.tsx'
import { createDb, type LocalDb } from '../db/local.ts'
import { createRepo } from '../db/repo.ts'
import { SYNC_TABLES } from '@shared/types.ts'
import { startScheduler, type Scheduler } from '../db/scheduler.ts'
import { seedDemo } from './demo.ts'

export const DEMO_DB_NAME = 'seafarer-budget-demo'

export function demoDb(): LocalDb {
  return createDb(DEMO_DB_NAME)
}

/** a demo «sync» takes this long, so the spinning arrows can be seen */
const DEMO_SYNC_MS = 600

/**
 * The real scheduler over a stand-in sync that sends nothing anywhere: it just marks the changed rows as sent, so
 * the cloud shows ✓ after a change (spinning for a moment) instead of «waiting» forever.
 */
function demoScheduler(db: LocalDb): Scheduler {
  const syncOnce = async () => {
    await new Promise((resolve) => setTimeout(resolve, DEMO_SYNC_MS))
    for (const t of SYNC_TABLES) {
      await db
        .syncTable(t)
        .where('dirty')
        .equals(1)
        .modify((row) => {
          row.dirty = 0
          delete row._changed
        })
    }
    return {}
  }
  return startScheduler({ syncOnce }, { debounceMs: 800, pollMs: 60_000, subscribe: () => () => {} })
}

/** Seeds the demo database on first open and returns the context for <AppProvider>. */
export async function openDemo(db: LocalDb): Promise<AppContextValue> {
  const now = () => new Date()
  await seedDemo(db, localDate(now(), DEFAULT_SETTINGS.timezone))
  const scheduler = demoScheduler(db)
  const repo = createRepo(db, { now, uuid: () => crypto.randomUUID(), onChange: scheduler.kick })
  return { db, repo, scheduler, now }
}
