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

  it('kicks on visibilitychange (visible) and focus, and not after stop()', async () => {
    const { sync, s } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    sync.syncOnce.mockClear()

    document.dispatchEvent(new Event('visibilitychange')) // jsdom: visibilityState is 'visible'
    await vi.advanceTimersByTimeAsync(2000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(2)

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(2) // hidden -> no kick
    spy.mockRestore()

    s.stop()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sync.syncOnce).toHaveBeenCalledTimes(2)
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

  it('an fx-rates failure alone keeps the status idle (I1)', async () => {
    const sync = { syncOnce: vi.fn(async () => ({ pushed: 1, pulled: 1, fxError: 'fx down' })) }
    const s = startScheduler(sync, { debounceMs: 10, pollMs: 1000, subscribe: () => () => {} })
    await vi.advanceTimersByTimeAsync(10)
    expect(s.status$.get()).toMatchObject({ state: 'idle', error: null })
    s.stop()
  })
})
