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

/**
 * «Значок в трее» (Windows program only): on — ✕ hides the program to the tray; off — no icon, ✕ closes it. The choice
 * lives in the program itself (src-tauri), it works before the page has loaded. The dev demo shows the row for preview.
 */
export function TrayRow() {
  const desk = useDesk()
  const available = isTauri() || import.meta.env.DEV
  const [tray, setTray] = useState<Tray>('on')
  useEffect(() => {
    if (!isTauri()) return
    void tauriInvoke<boolean>('tray_enabled').then((on) => setTray(on ? 'on' : 'off'))
  }, [])
  if (!desk || !available) return null
  const change = (next: Tray) => {
    setTray(next)
    if (isTauri()) void tauriInvoke('set_tray_enabled', { on: next === 'on' }).catch(() => setTray(next === 'on' ? 'off' : 'on'))
  }
  return (
    <SRow
      icon={MonitorDown}
      color="#32ADE6"
      title="Значок в трее"
      desc={tray === 'on' ? 'Крестик сворачивает программу в трей' : 'Значка нет, крестик закрывает программу'}
    >
      <Segmented<Tray> label="Значок в трее" options={OPTIONS} value={tray} onChange={change} />
    </SRow>
  )
}
