import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateGate } from './pwa-update.ts'

let state: 'visible' | 'hidden'

function setVisibility(next: 'visible' | 'hidden') {
  state = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  state = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
})

describe('createUpdateGate', () => {
  it('does not apply while visible', () => {
    const apply = vi.fn()
    const gate = createUpdateGate({ isEditing: () => false, apply, doc: document })
    gate.onNeedRefresh()
    setVisibility('visible')
    expect(apply).not.toHaveBeenCalled()
  })

  it('applies once the document becomes hidden', () => {
    const apply = vi.fn()
    const gate = createUpdateGate({ isEditing: () => false, apply, doc: document })
    gate.onNeedRefresh()
    setVisibility('hidden')
    expect(apply).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    setVisibility('hidden')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not apply while a record form is open even if hidden, then applies on the next hidden after it closes', () => {
    const apply = vi.fn()
    let editing = true
    const gate = createUpdateGate({ isEditing: () => editing, apply, doc: document })
    gate.onNeedRefresh()
    setVisibility('hidden')
    expect(apply).not.toHaveBeenCalled()
    setVisibility('visible')
    editing = false
    expect(apply).not.toHaveBeenCalled()
    setVisibility('hidden')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no update is waiting', () => {
    const apply = vi.fn()
    createUpdateGate({ isEditing: () => false, apply, doc: document })
    setVisibility('hidden')
    expect(apply).not.toHaveBeenCalled()
  })
})
