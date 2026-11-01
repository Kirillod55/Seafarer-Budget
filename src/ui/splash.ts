import { prefersReducedMotion } from './motion.ts'

/** The launch plays this long after a long absence: the tile, the anchor drawn, the badge, the name. */
const FULL_LAUNCH_MS = 1500
const FADE_MS = 340
/** Whatever happens, the launch screen never stays over the app. */
const GIVE_UP_MS = 10000

/**
 * Takes the launch screen of index.html away when the first real screen is there. After a long absence (data-long, the
 * time it started) it first plays to its end; on an ordinary start it goes at once.
 */
export function hideSplash(doc: Document = document): void {
  const el = doc.getElementById('splash')
  if (!el || el.classList.contains('going')) return
  el.classList.add('going')
  const started = Number(el.dataset.long)
  const left = started && !prefersReducedMotion() ? FULL_LAUNCH_MS - (Date.now() - started) : 0
  setTimeout(() => {
    el.classList.add('out')
    setTimeout(() => el.remove(), FADE_MS)
  }, Math.max(0, left))
}

export function watchSplash(doc: Document = document): void {
  setTimeout(() => hideSplash(doc), GIVE_UP_MS)
}

/** index.html reads this before any script has loaded, so the launch screen opens in the chosen theme. */
export function rememberTheme(t: string): void {
  try {
    localStorage.setItem('sb-theme', t)
  } catch {
    // no storage: the launch screen follows the system
  }
}
