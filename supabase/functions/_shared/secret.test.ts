import { describe, expect, it } from 'vitest'
import { safeEqual } from './secret.ts'

describe('safeEqual (secret headers)', () => {
  it('equal only for the same string; empty and missing never match', () => {
    expect(safeEqual('s3cret-Ab', 's3cret-Ab')).toBe(true)
    expect(safeEqual('s3cret-Ab', 's3cret-Ac')).toBe(false)
    expect(safeEqual('s3cret-Ab', 's3cret-A')).toBe(false)
    expect(safeEqual('s3cret-A', 's3cret-Ab')).toBe(false)
    expect(safeEqual(null, 's3cret')).toBe(false)
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual('ключ', 'ключ')).toBe(true)
    expect(safeEqual('ключ', 'ключи')).toBe(false)
  })
})
