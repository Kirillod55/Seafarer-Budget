import { Segmented } from '../../ui/Segmented.tsx'
import { useTheme, type ThemeChoice } from '../../ui/theme.ts'
import { MoreCard } from './common.tsx'

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
]

/** «Оформление» (spec §4, §6): «Авто» follows the system; applies at once, kept on this device only (Dexie meta). */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme()
  return (
    <MoreCard title="Оформление">
      <Segmented<ThemeChoice> label="Тема" options={THEMES} value={theme} onChange={setTheme} />
    </MoreCard>
  )
}
