import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from './scheduler.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const sync = { syncOnce: vi.fn(async () => ({ pushed: 0, pulled: 0 })) }
  let cb: () => void = () => {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((c: () => void) => {
    cb = c
    return unsubscribe
  })
  const s = startScheduler(sync, { debounceMs: 2000, pollMs: 60000, subscribe })
  return { sync, s, emit: () => cb(), unsubscribe }
}

describe('scheduler', () => {
  it('debounces several kicks into one syncOnce', async () => {
    const { sync, s } = setup()
    await vi.advanceTimersByTimeAsync(2000) // initial sync on start
    sync.syncOnce.mockClear()
    s.kick()
    await vi.advanceTimersByTimeAsync(1000)
    s.kick()
    await vi.advanceTimersByTimeAsync(1000)
    s.kick()
    expect(sync.syncOnce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1999)
    expect(sync.syncOnce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sync.syncOnce).toHaveBeenCalledTimes(1)
    s.stop()
  })

  it('polls every 60000 ms', async () => {
    const { sync, s } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    sync.syncOnce.mockClear()
    await vi.advanceTimersByTimeAsync(60000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('realtime events kick a debounced sync; stop cancels everything', async () => {
    const { sync, s, emit, unsubscribe } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    sync.syncOnce.mockClear()
    emit()
    emit()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(1)
    s.kick()
    s.stop()
    expect(unsubscribe).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(1)
  })

  it('reports status and errors', async () => {
    const sync = { syncOnce: vi.fn(async () => ({ pushed: 0, pulled: 0, error: 'boom' })) }
    const s = startScheduler(sync, { debounceMs: 10, pollMs: 1000, subscribe: () => () => {} })
    const seen: string[] = []
    s.status$.subscribe(() => seen.push(s.status$.get().state))
    await vi.advanceTimersByTimeAsync(10)
    expect(s.status$.get()).toMatchObject({ state: 'error', error: 'boom' })
    expect(seen).toContain('syncing')
    s.stop()
  })
})
