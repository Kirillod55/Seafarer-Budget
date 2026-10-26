import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/ui/fonts.css', 'utf8')

describe('Onest subsets (stage 2 carry-over)', () => {
  it('loads Latin, Latin Extended, Cyrillic, Cyrillic Extended and maths — not Vietnamese or symbols', () => {
    const files = [...css.matchAll(/onest-([a-z-]+)-wght-normal\.woff2/g)].map((m) => m[1]).sort()
    expect(files).toEqual(['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext', 'math'])
  })

  it('main.tsx uses it instead of the whole fontsource package', () => {
    const main = readFileSync('src/main.tsx', 'utf8')
    expect(main).toContain("import './ui/fonts.css'")
    expect(main).not.toContain("'@fontsource-variable/onest'")
  })
})
