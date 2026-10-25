/*
 * «Шторка не трогает экран под ней» (spec §6; prototype lockScroll/unlockScroll): while a sheet is open the page
 * under it is pinned — <body> becomes fixed at the current scroll, shifted up by it, so nothing moves — and on
 * closing by any path the window goes back exactly where it was. Locks nest: only the outermost one restores.
 */

let depth = 0
let saved: { y: number; style: Partial<Record<'position' | 'top' | 'left' | 'right' | 'overflow', string>> } | null = null

/** Pins <body> at the current scroll; the returned function (safe to call twice) unpins it and restores the scroll. */
export function lockScroll(): () => void {
  if (depth++ === 0) {
    const y = window.scrollY || 0
    const b = document.body.style
    saved = { y, style: { position: b.position, top: b.top, left: b.left, right: b.right, overflow: b.overflow } }
    b.position = 'fixed'
    b.top = `${-y}px`
    b.left = '0'
    b.right = '0'
    b.overflow = 'hidden'
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--depth > 0 || !saved) return
    const { y, style } = saved
    saved = null
    Object.assign(document.body.style, style)
    window.scrollTo(0, y)
  }
}
