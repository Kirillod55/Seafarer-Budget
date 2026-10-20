import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.ts'
import { createDb, type LocalDb } from './db/local.ts'
import { resolveStartup } from './startup.ts'

let n = 0
let db: LocalDb

beforeEach(() => {
  db = createDb(`startup-test-${++n}`)
})

const putSettings = () => db.settings.put({ ...DEFAULT_SETTINGS, id: 's1', deleted: false, dirty: 0 })

describe('resolveStartup (R18)', () => {
  it('is ready at once when settings already exist locally, without waiting for sync', async () => {
    await putSettings()
    const syncOnce = vi.fn()
    expect(await resolveStartup(db, syncOnce)).toBe('ready')
    expect(syncOnce).not.toHaveBeenCalled()
  })

  it('shows the wizard only when settings are still absent after a SUCCESSFUL sync', async () => {
    const syncOnce = vi.fn().mockResolvedValue({ pushed: 0, pulled: 0 })
    expect(await resolveStartup(db, syncOnce)).toBe('wizard')
    expect(syncOnce).toHaveBeenCalledTimes(1)
  })

  it('is ready when the sync pulled settings from the server', async () => {
    const syncOnce = vi.fn(async () => {
      await putSettings()
      return { pushed: 0, pulled: 1 }
    })
    expect(await resolveStartup(db, syncOnce)).toBe('ready')
  })

  it('needs internet when the sync reports an error and there are no local settings', async () => {
    const syncOnce = vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, error: 'Failed to fetch' })
    expect(await resolveStartup(db, syncOnce)).toBe('need_internet')
  })

  it('needs internet when the sync throws', async () => {
    const syncOnce = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await resolveStartup(db, syncOnce)).toBe('need_internet')
  })

  it('is ready when the sync reports an error but settings did arrive', async () => {
    const syncOnce = vi.fn(async () => {
      await putSettings()
      return { pushed: 0, pulled: 1, error: 'fx rates failed' }
    })
    expect(await resolveStartup(db, syncOnce)).toBe('ready')
  })

  it('ignores deleted settings rows', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, id: 's1', deleted: true, dirty: 0 })
    const syncOnce = vi.fn().mockResolvedValue({ pushed: 0, pulled: 0 })
    expect(await resolveStartup(db, syncOnce)).toBe('wizard')
  })
})
