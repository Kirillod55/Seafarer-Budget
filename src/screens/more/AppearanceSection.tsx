import { Segmented } from '../../ui/Segmented.tsx'
import { useTheme, type ThemeChoice } from '../../ui/theme.ts'
import { useDesk } from '../../desk/layout.ts'
import { Sun } from '../../ui/icons.ts'
import { MoreCard, SRow } from './common.tsx'

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
]

/** «Оформление» (spec §4, §6): «Авто» follows the system; applies at once, kept on this device only (Dexie meta). */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme()
  const seg = <Segmented<ThemeChoice> label="Тема" options={THEMES} value={theme} onChange={setTheme} />
  if (useDesk())
    return (
      <SRow icon={Sun} color="#FF9500" title="Тема" desc="Авто — как в системе Windows">
        {seg}
      </SRow>
    )
  return (
    <MoreCard title="Оформление">
      {seg}
    </MoreCard>
  )
}
