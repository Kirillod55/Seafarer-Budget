import { describe, expect, it } from 'vitest'
import { CATEGORY_STYLE, DEFAULT_CATEGORIES, categoryStyle } from './defaults.ts'
import type { Category } from './types.ts'

const cat = (over: Partial<Category>): Category => ({
  id: 'c', deleted: false, name: 'X', kind: 'expense', icon: '', keywords: [], archived: false, sort: 0,
  color: null, glyph: null, deleted_at: null, deleted_batch: null, ...over,
})

describe('categoryStyle', () => {
  it('uses the built-in style of a standard category by name', () => {
    expect(categoryStyle(cat({ name: 'Продукты' }))).toEqual({ color: '#30B455', glyph: 'cart' })
  })
  it('own fields win over the built-in ones', () => {
    expect(categoryStyle(cat({ name: 'Продукты', color: '#123456', glyph: 'gym' }))).toEqual({ color: '#123456', glyph: 'gym' })
  })
  it('falls back to grey tag for an unknown category', () => {
    expect(categoryStyle(cat({ name: 'Своя' }))).toEqual({ color: '#8E8E93', glyph: 'tag' })
  })
  it('every default category has a built-in style', () => {
    for (const c of DEFAULT_CATEGORIES) expect(CATEGORY_STYLE[c.name]).toBeDefined()
  })
})
