import type { CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import { useApp } from '../context.tsx'
import { NavBar } from '../nav/NavBar.tsx'
import { useNav } from '../nav/Navigator.tsx'
import { Archive, ChevronRight, CreditCard, Gauge, Tag, type LucideIcon } from '../ui/icons.ts'
import { AppearanceSection } from './more/AppearanceSection.tsx'
import { BudgetSection } from './more/BudgetSection.tsx'
import { CurrenciesSection } from './more/CurrenciesSection.tsx'
import { BackupSection, ModeSection, ReconcileSection } from './more/DataSection.tsx'
import { BotSection, PartnerSection } from './more/PartnerSection.tsx'
import './record.css'
import './goals.css'
import './more/more.css'

type MenuScreen = 'limits' | 'accounts' | 'cats' | 'archive'

const MENU: { screen: MenuScreen; label: string; icon: LucideIcon; color: string }[] = [
  { screen: 'limits', label: 'Лимиты', icon: Gauge, color: 'var(--act-arch)' },
  { screen: 'accounts', label: 'Счета', icon: CreditCard, color: 'var(--anchor)' },
  { screen: 'cats', label: 'Категории', icon: Tag, color: 'var(--accent-text)' },
  { screen: 'archive', label: 'Архив', icon: Archive, color: 'var(--act-edit)' },
]

/**
 * «Ещё» (spec §4, §9, §10; prototype v60 more()): the landing budget, the menu of deeper screens («Архив · N»),
 * the theme, the second person and the bot, the accounts mode, currencies, «Сверка», the backup, then «Выйти».
 * Every setting is saved on its own: `repo.put('settings', { id, field })`.
 */
export function More({ onSignOut }: { onSignOut(): void }) {
  const { db, now } = useApp()
  const nav = useNav()
  const data = useLiveQuery(async () => {
    const [settings, txs, rates, moves, goals, accounts, categories] = await Promise.all([
      db.settings.filter(alive).first(),
      db.transactions.filter(alive).toArray(),
      db.fx_rates.toArray(),
      db.goal_moves.filter(alive).toArray(),
      db.goals.filter(alive).toArray(),
      db.accounts.filter(alive).toArray(),
      db.categories.filter(alive).toArray(),
    ])
    return { settings, txs, rates, moves, goals, accounts, categories }
  }, [db])

  if (!data)
    return (
      <>
        <NavBar title="Ещё" />
        <p className="muted pad">Загрузка…</p>
      </>
    )
  const { settings, txs, rates, moves, goals, accounts, categories } = data
  if (!settings)
    return (
      <>
        <NavBar title="Ещё" />
        <p className="muted pad">Сначала завершите настройку</p>
      </>
    )

  const today = localDate(now(), settings.timezone)
  // everything put away (spec §4 «Ещё → Архив»): records, goals, categories and accounts; binned rows are not here
  const archived = [txs, goals, categories, accounts].reduce((n, rows) => n + rows.filter((r) => r.archived).length, 0)

  return (
    <>
      <NavBar title="Ещё" />
      <div className="more">
        <BudgetSection settings={settings} txs={txs} rates={rates} moves={moves} goals={goals} accounts={accounts} today={today} />

        <div className="group menu">
          {MENU.map(({ screen, label, icon: Icon, color }) => {
            const count = screen === 'archive' && archived > 0 ? archived : 0
            return (
              <button
                key={screen}
                type="button"
                aria-label={count ? `${label} · ${count}` : undefined}
                onClick={() => nav.push({ tab: 'more', screen })}
              >
                <span className="ic" style={{ '--c': color } as CSSProperties} aria-hidden="true">
                  <Icon strokeWidth={2} />
                </span>
                {label}
                {count > 0 && <span className="mcount num">{count}</span>}
                <span className={`chev${count ? ' after' : ''}`} aria-hidden="true">
                  <ChevronRight strokeWidth={2.2} />
                </span>
              </button>
            )
          })}
        </div>

        <AppearanceSection />
        <PartnerSection settings={settings} />
        <BotSection settings={settings} />
        <ModeSection settings={settings} />
        <CurrenciesSection settings={settings} />
        <ReconcileSection settings={settings} accounts={accounts} txs={txs} today={today} />
        <BackupSection today={today} partnerName={settings.partner_name} />
        {/* Task 13: the «Удаление данных» card (WipePanel) goes here, under «Резервная копия» (spec §4) */}

        <button type="button" className="btn-gray danger msignout" onClick={onSignOut}>
          Выйти
        </button>
      </div>
    </>
  )
}
