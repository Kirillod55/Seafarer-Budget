import { readFileSync } from 'node:fs'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProvider } from '../context.tsx'
import { createDb } from '../db/local.ts'
import { makeEnv } from '../test-utils.tsx'
import { applyTextScale, applyTheme, loadTheme, saveTheme, useTheme } from './theme.ts'

const css = readFileSync('src/ui/tokens.css', 'utf8')

const themeColor = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')

function stubSystemDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: dark && query.includes('dark'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('theme-fade')
  document.documentElement.style.removeProperty('--ts')
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
})

describe('applyTheme', () => {
  it('«Светлая» sets data-theme="light" and a white theme-color', () => {
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(themeColor()).toBe('#FFFFFF')
  })

  it('«Тёмная» sets data-theme="dark" and theme-color = dark --bg', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(themeColor()).toBe('#0E0F12')
  })

  it('«Как в системе» removes the attribute; theme-color follows the system', () => {
    applyTheme('dark')
    stubSystemDark(false)
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(themeColor()).toBe('#FFFFFF')
    stubSystemDark(true)
    applyTheme('system')
    expect(themeColor()).toBe('#0E0F12')
  })

  it('updates an existing theme-color meta instead of adding another', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#1f6feb'
    document.head.append(meta)
    applyTheme('light')
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
    expect(meta.content).toBe('#FFFFFF')
  })
})

describe('saveTheme / loadTheme', () => {
  it('defaults to «Как в системе» on a fresh database', async () => {
    expect(await loadTheme(createDb('theme-fresh'))).toBe('system')
  })

  it('returns the saved choice (survives a restart: a new Dexie instance on the same database)', async () => {
    const db = createDb('theme-saved')
    await saveTheme(db, 'light')
    expect(await loadTheme(createDb('theme-saved'))).toBe('light')
    await saveTheme(db, 'dark')
    expect(await loadTheme(db)).toBe('dark')
    expect(await db.meta.get('theme')).toEqual({ key: 'theme', value: 'dark' })
  })

  it('ignores a broken stored value', async () => {
    const db = createDb('theme-broken')
    await db.meta.put({ key: 'theme', value: 'purple' })
    expect(await loadTheme(db)).toBe('system')
  })
})

describe('useTheme', () => {
  it('switches the theme without a reload and stores it in meta', async () => {
    const env = makeEnv()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(AppProvider, { value: env, children })
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current[0]).toBe('system')
    await act(async () => result.current[1]('light'))
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.classList.contains('theme-fade')).toBe(true)
    expect(await loadTheme(env.db)).toBe('light')
  })

  it('starts from the theme already applied to <html>', () => {
    applyTheme('dark')
    const env = makeEnv()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(AppProvider, { value: env, children })
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current[0]).toBe('dark')
  })
})

describe('applyTextScale (Dynamic Type)', () => {
  it('keeps the scale at 1 where -apple-system-body is unknown', () => {
    applyTextScale()
    expect(document.documentElement.style.getPropertyValue('--ts')).toBe('1')
  })
})

/** Body of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

const DARK: Record<string, string> = {
  '--bg': '#0E0F12',
  '--card': '#181A1F',
  '--line': '#262930',
  '--text': '#F2F3F5',
  '--muted': '#8E939C',
  '--accent-text': '#C6F432',
  '--warn': '#FF8A5B',
  '--danger': '#FF5C5C',
  '--track': '#262930',
  '--anchor': '#5B9BFF',
  '--partner': '#E4E6EA',
  '--act-edit': '#55585F',
  '--act-del': '#FF453A',
  '--act-arch': '#C77700',
  '--pill-warn': '#F5B83D',
  '--glass-bg': '#24272D',
  '--toast-bg': '#2A2D33',
  '--glass-btn': '#1F2126',
  '--bar-bg': '#0E0F12',
}

const LIGHT: Record<string, string> = {
  '--bg': '#FFFFFF',
  '--card': '#FFFFFF',
  '--line': '#E8E8EC',
  '--text': '#14161A',
  '--muted': '#6B6B73',
  '--accent-text': '#4D6B00',
  '--warn': '#C2410C',
  '--danger': '#D70015',
  '--track': '#F2F2F5',
  '--anchor': '#1D4ED8',
  '--partner': '#3A3D44',
  '--act-edit': '#8E8E93',
  '--act-del': '#FF3B30',
  '--act-arch': '#FF9500',
  '--pill-warn': '#9A6200',
  '--glass-bg': '#FFFFFF',
  '--toast-bg': '#FFFFFF',
  '--glass-btn': '#F2F2F5',
  '--bar-bg': '#FFFFFF',
}

describe('tokens.css', () => {
  it('explicit theme rules beat the system dark rule (they come after it and are more specific)', () => {
    const media = css.indexOf('@media (prefers-color-scheme: dark)')
    const light = css.indexOf('html:not(#_)[data-theme="light"]')
    const dark = css.indexOf('html:not(#_)[data-theme="dark"]')
    expect(media).toBeGreaterThanOrEqual(0)
    expect(light).toBeGreaterThan(media)
    expect(dark).toBeGreaterThan(media)
  })

  it('has the §6 values in both themes', () => {
    expect(tokens(block('html:not(#_)[data-theme="dark"]'))).toMatchObject(DARK)
    expect(tokens(block('html:not(#_)[data-theme="light"]'))).toMatchObject(LIGHT)
    expect(tokens(block(':root'))).toMatchObject({
      ...LIGHT,
      '--accent': '#C6F432',
      '--on-accent': '#11140A',
      '--ios': 'cubic-bezier(.32, .72, 0, 1)',
      '--spring': 'cubic-bezier(.34, 1.45, .64, 1)',
    })
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
    expect(tokens(media.slice(media.indexOf('{', media.indexOf(':root')) + 1, media.indexOf('}')))).toMatchObject(DARK)
  })

  it('reacts to Increase Contrast and Reduce Motion', () => {
    expect(css).toContain('@media (prefers-contrast: more)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('Reduce Motion stops the theme fade: the fade rule only exists with no-preference', () => {
    const fade = css.indexOf('html.theme-fade')
    const media = css.lastIndexOf('@media (prefers-reduced-motion: no-preference)', fade)
    expect(media).toBeGreaterThanOrEqual(0)
    expect(css.slice(media, fade)).not.toContain('}') // the fade rule is the first thing inside that block
  })

  it('Increase Contrast does not repaint the selected tab', () => {
    const contrast = css.slice(css.indexOf('@media (prefers-contrast: more)'))
    expect(contrast).toContain('.tab:not(.active)')
    expect(contrast).not.toMatch(/\.tab\s*[,{]/)
  })

  it('glass is solid: no backdrop-filter', () => {
    expect(css).not.toMatch(/backdrop-filter/)
  })

  it('uses Onest with tabular figures and 17 px fields', () => {
    expect(css).toMatch(/--font:\s*'Onest Variable'/)
    expect(css).toMatch(/tabular-nums/)
    expect(css).toMatch(/input,\s*select,\s*textarea[^{]*\{[^}]*font-size:\s*max\(17px,\s*1rem\)/)
  })
})
