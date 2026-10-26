import { useEffect, useRef } from 'react'
import { useNav } from '../nav/Navigator.tsx'
import { useRecordSheet } from '../screens/RecordSheet.tsx'

/*
 * PC keys (spec §11 «Мышь и клавиатура»), listened to on the window so they work again and again whatever has focus:
 * N — new record; / — the quick input (from any section it goes to «Главная» first); ↑ ↓ — through the records
 * on the screen; Enter opens the focused one (it is a button); Delete / Backspace — delete it, with «Отменить».
 * Nothing fires while typing in a field, with a modifier, or while the record window or a menu is open (the page
 * under them does not react; the window and menus handle their own Esc).
 */

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')

const overlayOpen = () => !!document.querySelector('.sheet, .ctx, .glass, .syncfly')

/** The records (and clickable table rows) of the screen on top, in page order. */
const rows = () => [
  ...document.querySelectorAll<HTMLElement>('.screen:not(.below) .swipe:not(.collapse) > .tx, .screen:not(.below) .dtable tr.go'),
]

export function DeskKeys() {
  const nav = useNav()
  const { openRecord } = useRecordSheet()
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || overlayOpen()) return
      const active = document.activeElement
      if (e.code === 'KeyN' && !e.shiftKey) {
        e.preventDefault()
        openRecord()
      } else if (e.code === 'Slash' || e.key === '/') {
        e.preventDefault()
        const n = navRef.current
        const focusQuick = () => document.querySelector<HTMLInputElement>('.screen:not(.below) .qinput')?.focus()
        if (n.route.tab === 'home' && n.route.screen === 'root') focusQuick()
        else {
          n.open({ tab: 'home', screen: 'root' })
          // the home screen mounts on the next commit; its quick input shows once its data is read
          let tries = 0
          const wait = () => {
            if (document.querySelector('.screen:not(.below) .qinput')) focusQuick()
            else if (++tries < 40) setTimeout(wait, 25)
          }
          setTimeout(wait, 0)
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = rows()
        if (!list.length) return
        e.preventDefault()
        const i = list.indexOf(active as HTMLElement)
        const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
        list[next].focus()
        list[next].scrollIntoView?.({ block: 'nearest' })
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!(active instanceof HTMLElement) || !rows().includes(active)) return
        // the row's own «Удалить» (hover button or table action): same undo, same focus on the neighbour
        const del = active.closest('[data-swipe-row], tr')?.querySelector<HTMLButtonElement>('.hb.del')
        if (!del) return
        e.preventDefault()
        del.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openRecord])

  return null
}
