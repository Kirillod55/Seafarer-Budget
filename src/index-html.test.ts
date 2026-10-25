import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync('index.html', 'utf8')

describe('index.html (iPhone shell)', () => {
  it('extends under the notch with viewport-fit=cover', () => {
    expect(html).toMatch(/<meta[^>]+name="viewport"[^>]+viewport-fit=cover/)
  })

  it('is installable as a standalone web app', () => {
    expect(html).toMatch(/<meta[^>]+name="apple-mobile-web-app-capable"[^>]+content="yes"/)
  })

  it('points the touch icon at a relative path (absolute /icons/ misses the /Seafarer-Budget/ base)', () => {
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png" />')
    expect(html).not.toMatch(/rel="apple-touch-icon"[^>]*href="\//)
  })
})

describe('1.1 theme colours', () => {
  it('index.html starts with the dark --bg as theme-color (applyTheme updates it at start)', () => {
    expect(html).toContain('<meta name="theme-color" content="#0E0F12" />')
  })

  it('the PWA manifest uses the dark --bg', () => {
    const config = readFileSync('vite.config.ts', 'utf8')
    expect(config).toMatch(/theme_color:\s*'#0E0F12'/)
    expect(config).toMatch(/background_color:\s*'#0E0F12'/)
  })
})
