export interface SchedulerStatus {
  state: 'idle' | 'syncing' | 'error'
  lastSyncAt: number | null
  error: string | null
}

/** Minimal observable store (compatible with React's useSyncExternalStore). */
export interface StatusStore {
  get(): SchedulerStatus
  subscribe(cb: () => void): () => void
}

export interface Scheduler {
  kick(): void
  /**
   * Sync right now (pull to refresh): skips the debounce; if a sync is running, one more runs after it.
   * Resolves with the status once the runs are over (or at once after stop()).
   */
  syncNow(): Promise<SchedulerStatus>
  stop(): void
  status$: StatusStore
}

export function startScheduler(
  sync: { syncOnce(): Promise<unknown> },
  opts: { debounceMs: number; pollMs: number; subscribe(cb: () => void): () => void },
): Scheduler {
  let status: SchedulerStatus = { state: 'idle', lastSyncAt: null, error: null }
  const listeners = new Set<() => void>()
  const setStatus = (next: SchedulerStatus) => {
    status = next
    for (const l of [...listeners]) l()
  }

  let stopped = false
  let running = false
  let again = false
  let debounce: ReturnType<typeof setTimeout> | null = null
  /** syncNow() callers waiting for the current chain of runs to end */
  let waiters: (() => void)[] = []
  const settle = () => {
    const w = waiters
    waiters = []
    for (const f of w) f()
  }

  async function run(): Promise<void> {
    if (stopped) return
    if (running) {
      again = true // a change arrived mid-sync; go once more afterwards
      return
    }
    running = true
    setStatus({ ...status, state: 'syncing' })
    try {
      const res = (await sync.syncOnce()) as { error?: string } | undefined
      if (res?.error) setStatus({ ...status, state: 'error', error: res.error })
      else setStatus({ state: 'idle', lastSyncAt: Date.now(), error: null })
    } catch (e) {
      setStatus({ ...status, state: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      running = false
    }
    if (again && !stopped) {
      again = false
      return run()
    }
    settle()
  }

  function kick(): void {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void run()
    }, opts.debounceMs)
  }

  const poll = setInterval(() => void run(), opts.pollMs)
  const unsubscribe = opts.subscribe(kick)
  const onOnline = () => kick()
  const onVisibility = () => {
    if (document.visibilityState === 'visible') kick()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onOnline)
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  kick() // initial sync shortly after start

  return {
    kick,
    syncNow() {
      if (debounce) {
        clearTimeout(debounce)
        debounce = null
      }
      return new Promise<SchedulerStatus>((resolve) => {
        if (stopped) return resolve(status)
        waiters.push(() => resolve(status))
        if (running) again = true
        else void run()
      })
    },
    stop() {
      stopped = true
      settle()
      if (debounce) clearTimeout(debounce)
      clearInterval(poll)
      unsubscribe()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
        window.removeEventListener('focus', onOnline)
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    },
    status$: {
      get: () => status,
      subscribe(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
}
