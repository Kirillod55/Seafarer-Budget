import { describe, expect, it } from 'vitest'
import { isTauri } from './runtime.ts'

describe('isTauri', () => {
  it('is false in a plain browser window', () => {
    expect(isTauri()).toBe(false)
    expect(isTauri({})).toBe(false)
  })

  it('is true when Tauri has injected its internals', () => {
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true)
  })
})
