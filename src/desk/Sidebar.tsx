import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { useApp } from '../context.tsx'
import { partnerLabel } from '../lib/records.ts'
import type { Route } from '../nav/Navigator.tsx'
import { Anchor, Archive, ChartPie, CreditCard, Gauge, House, Settings, Tag, Target, type LucideIcon } from '../ui/icons.ts'

/*
 * The PC menu (spec §11 «Меню слева», «Вид Windows 11»; prototype renderSide): the anchor and «Seafarer Budget»,
 * seven sections, a divider, «Настройки» (the phone's «Ещё»). At the bottom the second person's bot status and the
 * keys. On 1024–1279 px CSS (html.desk-s) leaves only the icons; each item keeps its name as a tooltip.
 */

export type SideItem = 'home' | 'report' | 'goals' | 'limits' | 'accounts' | 'cats' | 'archive' | 'settings'

const ITEMS: { id: SideItem; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Главная', icon: House },
  { id: 'report', label: 'Отчёт', icon: ChartPie },
  { id: 'goals', label: 'Цели', icon: Target },
  { id: 'limits', label: 'Лимиты', icon: Gauge },
  { id: 'accounts', label: 'Счета', icon: CreditCard },
  { id: 'cats', label: 'Категории', icon: Tag },
  { id: 'archive', label: 'Архив', icon: Archive },
]
const SETTINGS = {
  id: 'settings' as const,
  label: 'Настройки',
  icon: Settings,
}

/** The screen each item opens (a stack of just that screen). */
export function routeOf(item: SideItem): Route {
  switch (item) {
    case 'home':
    case 'report':
    case 'goals':
      return { tab: item, screen: 'root' }
    case 'settings':
      return { tab: 'more', screen: 'root' }
    default:
      return { tab: 'more', screen: item }
  }
}

/** The item lit for a route: the calendar belongs to «Главная», «Расходы» to where they were opened from. */
export function activeItem(route: Route): SideItem {
  switch (route.screen) {
    case 'root':
      return route.tab === 'more' ? 'settings' : route.tab
    case 'calendar':
      return 'home'
    case 'records':
      return route.from === 'cats' ? 'cats' : 'report'
    default:
      return route.screen
  }
}

export function Sidebar({ current, onOpen }: { current: SideItem; onOpen(item: SideItem): void }) {
  const { db } = useApp()
  const settings = useLiveQuery(() => db.settings.filter(alive).first(), [db])

  const item = ({ id, label, icon: Icon }: { id: SideItem; label: string; icon: LucideIcon }) => (
    <button key={id} type="button" className="si" title={label} aria-current={current === id ? 'page' : undefined} onClick={() => onOpen(id)}>
      <Icon aria-hidden="true" strokeWidth={2} />
      <span className="lbl">{label}</span>
    </button>
  )

  const linked = !!settings?.partner_seen_at
  const who = `${partnerLabel(settings?.partner_name)} ${linked ? 'подключена к боту' : 'не подключена к боту'}`

  return (
    <aside className="side" aria-label="Разделы">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <Anchor strokeWidth={2.2} />
        </span>
        <span className="bt">Seafarer Budget</span>
      </div>
      {ITEMS.map(item)}
      <div className="sep" />
      {item(SETTINGS)}
      <div className="foot">
        {settings && (
          <button type="button" className={`who2${linked ? '' : ' off'}`} title={who} aria-label={who} onClick={() => onOpen('settings')}>
            <span className="dotok" aria-hidden="true" />
            <span className="lbl">{who}</span>
          </button>
        )}
        <div className="keys">
          <kbd>N</kbd> новая запись
          <br />
          <kbd>/</kbd> быстрый ввод
          <br />
          <kbd>↑</kbd>
          <kbd>↓</kbd> <kbd>Enter</kbd> по списку
          <br />
          <kbd>Delete</kbd> удалить · <kbd>Esc</kbd> закрыть
        </div>
      </div>
    </aside>
  )
}
