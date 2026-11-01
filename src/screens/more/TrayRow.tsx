import { useEffect, useState } from 'react'
import { useDesk } from '../../desk/layout.ts'
import { MonitorDown } from '../../ui/icons.ts'
import { Segmented } from '../../ui/Segmented.tsx'
import { isTauri, tauriInvoke } from '../../runtime.ts'
import { SRow } from './common.tsx'

type Tray = 'on' | 'off'
const OPTIONS: { value: Tray; label: string }[] = [
  { value: 'on', label: 'Вкл' },
  { value: 'off', label: 'Выкл' },
]

/** The program's choice, kept between visits: the settings open with the switch already where it stands. */
let known: Tray | null = null
const read = (): Promise<Tray> =>
  tauriInvoke<boolean>('tray_enabled').then(
    (on) => (known = on ? 'on' : 'off'),
    () => (known = 'on'),
  )

/**
 * «Значок в трее» (Windows program only): on — ✕ hides the program to the tray; off — no icon, ✕ closes it. The choice
 * lives in the program itself (src-tauri), it works before the page has loaded. The switch appears once the choice is
 * known: placed there from its first frame, it never slides from a guess. The dev demo shows the row for preview.
 */
export function TrayRow() {
  const desk = useDesk()
  const available = isTauri() || import.meta.env.DEV
  const [tray, setTray] = useState<Tray | null>(isTauri() ? known : 'on')
  useEffect(() => {
    if (isTauri() && !known) void read().then(setTray)
  }, [])
  if (!desk || !available) return null
  const change = (next: Tray) => {
    known = next
    setTray(next)
    if (isTauri())
      void tauriInvoke('set_tray_enabled', { on: next === 'on' }).catch(() => {
        known = next === 'on' ? 'off' : 'on'
        setTray(known)
      })
  }
  return (
    <SRow
      icon={MonitorDown}
      color="#32ADE6"
      title="Значок в трее"
      desc={tray === 'off' ? 'Значка нет, крестик закрывает программу' : 'Крестик сворачивает программу в трей'}
    >
      {tray && <Segmented<Tray> label="Значок в трее" options={OPTIONS} value={tray} onChange={change} />}
    </SRow>
  )
}

// read at start, so that the first visit to the settings has the answer too
if (isTauri()) void read()
