import { createContext, useContext, type ReactNode } from 'react'
import type { LocalDb } from './db/local.ts'
import type { Repo } from './db/repo.ts'
import type { Scheduler } from './db/scheduler.ts'

export interface AppContextValue {
  db: LocalDb
  repo: Repo
  scheduler: Scheduler
  now(): Date
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}
