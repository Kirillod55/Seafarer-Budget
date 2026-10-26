import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProvider, type AppContextValue } from './context.tsx'
import { createDb } from './db/local.ts'
import { createRepo } from './db/repo.ts'
import type { Scheduler } from './db/scheduler.ts'

export const TEST_NOW = new Date('2026-10-21T12:00:00Z')
export const TEST_TODAY = '2026-10-21'

let dbCounter = 0

export function stubScheduler(): Scheduler {
  const status = { state: 'idle' as const, lastSyncAt: null, error: null }
  return {
    kick: vi.fn(),
    stop: vi.fn(),
    syncNow: vi.fn(async () => status),
    status$: { get: () => status, subscribe: () => () => {} },
  }
}

/** Fresh fake-indexeddb db (unique name per call), real repo, stub scheduler, fixed clock. */
export function makeEnv(): AppContextValue {
  const db = createDb(`ui-test-${++dbCounter}`)
  const scheduler = stubScheduler()
  let ids = 0
  const repo = createRepo(db, {
    now: () => TEST_NOW,
    uuid: () => `id-${++ids}`,
    onChange: scheduler.kick,
  })
  return { db, repo, scheduler, now: () => TEST_NOW }
}

export function renderWithApp(ui: ReactElement, env: AppContextValue = makeEnv()) {
  return { env, ...render(<AppProvider value={env}>{ui}</AppProvider>) }
}
