import type { CSSProperties } from 'react'
import { categoryStyle } from '@shared/defaults.ts'
import type { Category } from '@shared/types.ts'
import { CATEGORY_GLYPHS, Tag } from './icons.ts'
import './ui.css'

/** Relative luminance (WCAG) of a #RRGGBB colour; 0 for anything else. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** A colour so light that a white glyph on it would vanish (yellow #FFCC00): the glyph turns dark (#1C1C1E). */
export const isLightColor = (hex: string): boolean => luminance(hex) > 0.55

/*
 * Category tile (spec §6 «Иконки категорий», «Значки на стекле — сплошные плитки»): the outline glyph on a tile
 * of the category colour — its own colour/glyph or the built-in one (categoryStyle). On a card the tile is a pale
 * wash of the colour with a coloured glyph; inside a glass menu or a toast CSS makes it solid with a white glyph
 * (dark for light colours — the .lt class).
 */
export function CategoryIcon({ category, size = 'md' }: { category: Category; size?: 'sm' | 'md' }) {
  const { color, glyph } = categoryStyle(category)
  const Glyph = CATEGORY_GLYPHS[glyph] ?? Tag
  const cls = `ic${size === 'sm' ? ' sm' : ''}${isLightColor(color) ? ' lt' : ''}`
  return (
    <span className={cls} style={{ '--c': color } as CSSProperties} aria-hidden="true">
      <Glyph strokeWidth={2} />
    </span>
  )
}
