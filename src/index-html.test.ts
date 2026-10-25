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
