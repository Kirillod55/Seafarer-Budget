import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChartPie, Ellipsis, House, Target, type LucideIcon } from '../ui/icons.ts'
import { useBackSwipe } from './useBackSwipe.ts'
import './nav.css'

/*
 * Phone navigation (spec §3 item 7, §6): four tabs «Главная · Отчёт · Цели · Ещё» and a screen stack per visit.
 * A tab tap opens that tab's root; deeper screens are pushed and «‹ …» / swipe right pops them. Screen depth
 * picks the transition: deeper slides in from the right, back slides out to the right, tabs lift in.
 */

export type Tab = 'home' | 'report' | 'goals' | 'more'

export type Route = { tab: Tab } & (
  | { screen: 'root' }
  | { screen: 'calendar' }
  | { screen: 'records'; month: string; category: string | null; from: 'report' | 'cats' }
  | { screen: 'limits' | 'accounts' | 'cats' | 'archive' }
)

export interface Nav {
  route: Route
  push(r: Route): void
  back(): void
  switchTab(t: Tab): void
}

/** Tabs 0; calendar, limits, accounts, categories, archive 1; «Расходы» 2 (from «Категории» — deeper than them). */
export function depthOf(r: Route): number {
  return r.screen === 'root' ? 0 : r.screen === 'records' ? 2 : 1
}

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Главная', icon: House },
  { id: 'report', label: 'Отчёт', icon: ChartPie },
  { id: 'goals', label: 'Цели', icon: Target },
  { id: 'more', label: 'Ещё', icon: Ellipsis },
]

type Transition = 'push' | 'pop' | 'tab' | 'none'
/**
 * A stack entry stays mounted while deeper screens are on top of it (hidden, inert, out of flow), so going back
 * shows the same page with its data, local state and scroll position — and the back swipe reveals it underneath.
 */
interface Entry {
  id: number
  route: Route
  /** window scroll position saved when a deeper screen was pushed over it */
  y: number
}
interface State {
  stack: Entry[]
  transition: Transition
  /** Bumps on every tab change: the selected tab's icon bounces. */
  tabChanges: number
}

const ANIM: Record<Transition, string> = { push: ' v-push', pop: ' v-pop', tab: ' v-tab', none: '' }

const NavContext = createContext<Nav | null>(null)
/** false while a screen is hidden under a deeper one: its window listeners (scroll, resize) stay off. */
const ActiveContext = createContext(true)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('useNav() outside <Navigator>')
  return nav
}

export function useScreenActive(): boolean {
  return useContext(ActiveContext)
}

export function Navigator({
  renderScreen,
  onNavigate,
}: {
  renderScreen(route: Route): ReactNode
  /** Called on every push / back / tab tap (the shell drops its open record form). */
  onNavigate?(): void
}) {
  const seq = useRef(0)
  const [state, setState] = useState<State>({
    stack: [{ id: 0, route: { tab: 'home', screen: 'root' }, y: 0 }],
    transition: 'none',
    tabChanges: 0,
  })
  const els = useRef(new Map<number, HTMLElement>())
  const underRef = useRef<HTMLElement | null>(null)
  const [topEl, setTopEl] = useState<HTMLElement | null>(null)
  const navigated = useRef(onNavigate)
  navigated.current = onNavigate

  const push = useCallback((route: Route) => {
    navigated.current?.()
    const y = window.scrollY || 0
    const id = ++seq.current
    setState((s) => {
      const stack = s.stack.slice()
      stack[stack.length - 1] = { ...stack[stack.length - 1], y }
      return { ...s, stack: [...stack, { id, route, y: 0 }], transition: 'push' }
    })
  }, [])

  const pop = useCallback((transition: Transition) => {
    navigated.current?.()
    setState((s) => (s.stack.length > 1 ? { ...s, stack: s.stack.slice(0, -1), transition } : s))
  }, [])
  const back = useCallback(() => pop('pop'), [pop])

  const switchTab = useCallback((tab: Tab) => {
    navigated.current?.()
    const id = ++seq.current
    setState((s) => {
      const cur = s.stack[s.stack.length - 1].route
      if (cur.tab !== tab) return { stack: [{ id, route: { tab, screen: 'root' }, y: 0 }], transition: 'tab', tabChanges: s.tabChanges + 1 }
      // the current tab from a deeper screen: back to its root (still mounted, with its scroll), like «‹ …»
      return s.stack.length === 1 ? s : { ...s, stack: s.stack.slice(0, 1), transition: 'pop' }
    })
  }, [])

  const { stack, transition } = state
  const top = stack[stack.length - 1]
  const route = top.route
  const nav = useMemo<Nav>(() => ({ route, push, back, switchTab }), [route, push, back, switchTab])
  underRef.current = stack.length > 1 ? (els.current.get(stack[stack.length - 2].id) ?? null) : null

  // When the top screen changes: lower screens keep showing their saved spot inside their fixed box (that is what
  // the back swipe reveals), the top one gets the window scroll back, and after push/back focus moves to its title.
  const shown = useRef(top.id)
  useLayoutEffect(() => {
    for (const e of stack.slice(0, -1)) {
      const el = els.current.get(e.id)
      if (el) el.scrollTop = e.y
    }
    window.scrollTo(0, top.y)
    const el = els.current.get(top.id) ?? null
    setTopEl(el)
    if (shown.current === top.id) return // first mount
    shown.current = top.id
    if (transition !== 'tab') el?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [top.id])

  useBackSwipe(topEl, {
    enabled: stack.length > 1,
    underRef,
    onCommit: () => pop('none'), // the page has already slid away: no second animation
  })

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        {stack.map((e, i) => {
          const isTop = i === stack.length - 1
          return (
            <section
              key={e.id}
              ref={(el) => {
                if (el) els.current.set(e.id, el)
                else els.current.delete(e.id)
              }}
              className={isTop ? `screen${ANIM[transition]}` : 'screen below'}
              inert={!isTop}
              aria-hidden={isTop ? undefined : true}
            >
              <ActiveContext.Provider value={isTop}>{renderScreen(e.route)}</ActiveContext.Provider>
            </section>
          )
        })}
        <nav className="tabs" aria-label="Разделы">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = route.tab === id
            return (
              <button
                key={id}
                type="button"
                className={`tab${active ? ' active' : ''}${active && state.tabChanges > 0 ? ' pop' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => switchTab(id)}
              >
                {/* keyed by the tab-change count, so the icon remounts and bounces on every switch */}
                <span className="tab-ic" key={active ? `on${state.tabChanges}` : 'off'} aria-hidden="true">
                  <Icon strokeWidth={2} />
                </span>
                {label}
              </button>
            )
          })}
        </nav>
      </div>
    </NavContext.Provider>
  )
}
