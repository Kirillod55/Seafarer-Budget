// Must come first: Dexie reads the global indexedDB when it is first imported.
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom has no layout, and its window.scrollTo only prints «not implemented»: keep the position so tests can read it.
// (Some suites run in the node environment, without a window.)
if (typeof window !== 'undefined') {
  window.scrollTo = ((x: number | ScrollToOptions = 0, y = 0) => {
    const top = typeof x === 'object' ? (x.top ?? window.scrollY) : y
    Object.defineProperty(window, 'scrollY', { value: top, configurable: true, writable: true })
    Object.defineProperty(window, 'pageYOffset', { value: top, configurable: true, writable: true })
  }) as typeof window.scrollTo
}

afterEach(() => {
  cleanup()
  if (typeof window !== 'undefined') window.scrollTo(0, 0)
})
