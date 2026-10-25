import { describe, expect, it } from 'vitest'
import { alive, liveRows } from './alive.ts'

describe('alive', () => {
  it('a normal row is alive', () => {
    expect(alive({ deleted: false, deleted_at: null })).toBe(true)
  })

  it('deleted = true is gone', () => {
    expect(alive({ deleted: true, deleted_at: null })).toBe(false)
  })

  it('deleted_at set (in the undo bin) is gone', () => {
    expect(alive({ deleted: false, deleted_at: '2026-10-25T10:00:00.000Z' })).toBe(false)
  })

  it('a 1.0 row without deleted_at is alive', () => {
    expect(alive({ deleted: false })).toBe(true)
    expect(alive({ deleted: true })).toBe(false)
  })
})

describe('liveRows', () => {
  it('keeps only the alive rows', () => {
    const rows = [
      { id: 'a', deleted: false },
      { id: 'b', deleted: true },
      { id: 'c', deleted: false, deleted_at: '2026-10-25T10:00:00.000Z' },
      { id: 'd', deleted: false, deleted_at: null },
    ]
    expect(liveRows(rows).map((r) => r.id)).toEqual(['a', 'd'])
  })
})
