import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context.tsx'
import type { LocalDb } from '../db/local.ts'

/** «Как в системе» / «Светлая» / «Тёмная». Stored per device (Dexie meta), never synced. */
export type ThemeChoice = 'system' | 'light' | 'dark'

const META_KEY = 'theme'
/** --bg of each theme: the iPhone status bar and the Windows title bar take this colour. */
const THEME_BG = { light: '#FFFFFF', dark: '#0E0F12' } as const
const FADE_MS = 450

function isChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark'
}

export async function loadTheme(db: LocalDb): Promise<ThemeChoice> {
  try {
    const row = await db.meta.get(META_KEY)
    return isChoice(row?.value) ? row.value : 'system'
  } catch {
    return 'system' // storage unavailable: follow the system
  }
}

export async function saveTheme(db: LocalDb, t: ThemeChoice): Promise<void> {
  await db.meta.put({ key: META_KEY, value: t })
}

function systemDark(doc: Document): boolean {
  const win = doc.defaultView
  return typeof win?.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Sets / removes data-theme on <html> and points <meta name="theme-color"> at the theme's --bg. */
export function applyTheme(t: ThemeChoice, doc: Document = document): void {
  const root = doc.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)

  const effective = t === 'system' ? (systemDark(doc) ? 'dark' : 'light') : t
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = doc.createElement('meta')
    meta.name = 'theme-color'
    doc.head.append(meta)
  }
  meta.content = THEME_BG[effective]
}

/** The choice currently applied to <html> (applyTheme ran before the first render). */
function appliedTheme(doc: Document = document): ThemeChoice {
  const attr = doc.documentElement.getAttribute('data-theme')
  return attr === 'light' || attr === 'dark' ? attr : 'system'
}

/** While «Как в системе» is on, keeps theme-color in step with the system switching light/dark. */
export function watchSystemTheme(doc: Document = document): () => void {
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  if (!mq?.addEventListener) return () => {}
  const onChange = () => {
    if (appliedTheme(doc) === 'system') applyTheme('system', doc)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

let fadeTimer: ReturnType<typeof setTimeout> | null = null

/** Colours flow into the new theme over 0.4 s (CSS html.theme-fade; off with Reduce Motion via CSS). */
function fadeTheme(doc: Document): void {
  const root = doc.documentElement
  root.classList.add('theme-fade')
  if (fadeTimer) clearTimeout(fadeTimer)
  fadeTimer = setTimeout(() => {
    root.classList.remove('theme-fade')
    fadeTimer = null
  }, FADE_MS)
}

/**
 * Dynamic Type: Safari reports the user's text size through the -apple-system-body font. --ts = that size ÷ 17,
 * clamped to 1…1.3; tokens.css sizes the root font (1rem) by it. Elsewhere --ts stays 1.
 */
export function applyTextScale(doc: Document = document): void {
  let ts = 1
  const probe = doc.createElement('span')
  probe.style.font = '-apple-system-body'
  if (probe.style.font && doc.body) {
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    doc.body.append(probe)
    const size = parseFloat(doc.defaultView?.getComputedStyle(probe).fontSize ?? '')
    probe.remove()
    if (size > 0) ts = Math.min(1.3, Math.max(1, size / 17))
  }
  doc.documentElement.style.setProperty('--ts', String(Math.round(ts * 1000) / 1000))
}

/** The theme switch of «Ещё»: applies at once (with the colour flow) and remembers the choice on this device. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const { db } = useApp()
  const [theme, setTheme] = useState<ThemeChoice>(() => appliedTheme())
  const chosen = useRef(false)

  useEffect(() => {
    let live = true
    void loadTheme(db).then((t) => {
      if (live && !chosen.current) setTheme(t) // a choice made meanwhile wins over the stored one
    })
    return () => {
      live = false
    }
  }, [db])

  const choose = useCallback(
    (t: ThemeChoice) => {
      chosen.current = true
      setTheme(t)
      fadeTheme(document)
      applyTheme(t)
      void saveTheme(db, t)
    },
    [db],
  )

  return [theme, choose]
}
