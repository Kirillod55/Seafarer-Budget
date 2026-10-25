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
/** A stack entry keeps the page's scroll position, so going back lands on the same spot. */
interface Entry {
  route: Route
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

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('useNav() outside <Navigator>')
  return nav
}

const scrollY = () => (typeof window === 'undefined' ? 0 : window.scrollY || 0)

function scrollToY(y: number) {
  // jsdom has no layout: scrolling there only prints «not implemented»
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return
  window.scrollTo(0, y)
}

function keyOf(r: Route, depth: number): string {
  return r.screen === 'records' ? `${depth}:${r.tab}:records:${r.month}:${r.category ?? ''}:${r.from}` : `${depth}:${r.tab}:${r.screen}`
}

export function Navigator({
  renderScreen,
  onNavigate,
}: {
  renderScreen(route: Route): ReactNode
  /** Called on every push / back / tab tap (the shell drops its open record form). */
  onNavigate?(): void
}) {
  const [state, setState] = useState<State>({
    stack: [{ route: { tab: 'home', screen: 'root' }, y: 0 }],
    transition: 'none',
    tabChanges: 0,
  })
  const [peek, setPeek] = useState(false)
  const [screenEl, setScreenEl] = useState<HTMLElement | null>(null)
  const underRef = useRef<HTMLDivElement>(null)
  const navigated = useRef(onNavigate)
  navigated.current = onNavigate

  const push = useCallback((route: Route) => {
    navigated.current?.()
    const y = scrollY()
    setState((s) => {
      const stack = s.stack.slice()
      stack[stack.length - 1] = { ...stack[stack.length - 1], y }
      return { ...s, stack: [...stack, { route, y: 0 }], transition: 'push' }
    })
  }, [])

  const pop = useCallback((transition: Transition) => {
    navigated.current?.()
    setState((s) => (s.stack.length > 1 ? { ...s, stack: s.stack.slice(0, -1), transition } : s))
  }, [])
  const back = useCallback(() => pop('pop'), [pop])

  const switchTab = useCallback((tab: Tab) => {
    navigated.current?.()
    setState((s) => {
      const cur = s.stack[s.stack.length - 1].route
      if (cur.tab === tab && s.stack.length === 1) return s // already on that root
      return {
        stack: [{ route: { tab, screen: 'root' }, y: 0 }],
        // a tap on the current tab from a deeper screen returns to its root like «‹ …»
        transition: cur.tab === tab ? 'pop' : 'tab',
        tabChanges: s.tabChanges + (cur.tab === tab ? 0 : 1),
      }
    })
  }, [])

  const top = state.stack[state.stack.length - 1]
  const prev = state.stack.length > 1 ? state.stack[state.stack.length - 2] : null
  const route = top.route
  const nav = useMemo<Nav>(() => ({ route, push, back, switchTab }), [route, push, back, switchTab])

  // a new screen starts at the top; going back restores where the previous one was
  const key = keyOf(route, state.stack.length)
  useLayoutEffect(() => {
    scrollToY(top.y)
    setPeek(false)
  }, [key])

  useBackSwipe(screenEl, {
    enabled: prev !== null,
    underRef,
    onStart: () => setPeek(true),
    onCancel: () => setPeek(false),
    onCommit: () => pop('none'), // the page has already slid away: no second animation
  })

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        {peek && prev && (
          // the previous page shows underneath while the finger drags this one away
          <div className="under" ref={underRef} aria-hidden="true" inert style={{ transform: 'translateX(-30%)' }}>
            <section className="screen" style={{ marginTop: -prev.y }}>
              {renderScreen(prev.route)}
            </section>
          </div>
        )}
        <section key={key} ref={setScreenEl} className={`screen${ANIM[state.transition]}`}>
          {renderScreen(route)}
        </section>
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
