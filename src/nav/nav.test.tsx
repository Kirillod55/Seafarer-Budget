import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavBar } from './NavBar.tsx'
import { Navigator, depthOf, useNav, type Route } from './Navigator.tsx'

type Nav = ReturnType<typeof useNav>
let nav: Nav

const TITLES: Record<Route['screen'], string> = {
  root: '',
  calendar: 'Календарь',
  records: 'Расходы',
  limits: 'Лимиты',
  accounts: 'Счета',
  cats: 'Категории',
  archive: 'Архив',
}
const TAB_TITLES = { home: 'Главная', report: 'Отчёт', goals: 'Цели', more: 'Ещё' } as const

/** Stub screens: a NavBar with the route's title, a swipeable row and a field. */
function Stub({ route }: { route: Route }) {
  nav = useNav()
  const title = route.screen === 'root' ? TAB_TITLES[route.tab] : TITLES[route.screen]
  return (
    <>
      <NavBar back={route.screen === 'root' ? undefined : { label: 'Назад' }} title={title} />
      <div data-swipe-row="" data-testid="row">
        строка
      </div>
      <input aria-label="Поле" />
      <p data-testid="body">тело</p>
    </>
  )
}

function setup() {
  return render(<Navigator renderScreen={(route) => <Stub route={route} />} />)
}

const heading = () => screen.getByRole('heading', { level: 1 }).textContent
const activeTab = () => screen.getByRole('button', { current: 'page' }).textContent

afterEach(() => vi.unstubAllGlobals())

describe('Navigator', () => {
  it('has four tabs «Главная · Отчёт · Цели · Ещё», opens on «Главная»', () => {
    setup()
    const tabs = screen.getByRole('navigation', { name: 'Разделы' })
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Главная', 'Отчёт', 'Цели', 'Ещё'])
    expect(nav.route).toEqual({ tab: 'home', screen: 'root' })
    expect(activeTab()).toBe('Главная')
  })

  it('a tab tap switches to its root and highlights it', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Цели' }))
    expect(nav.route).toEqual({ tab: 'goals', screen: 'root' })
    expect(heading()).toBe('Цели')
    expect(activeTab()).toBe('Цели')
    expect(screen.getByRole('button', { name: 'Цели' }).className).toContain('active')
  })

  it('push «Категории» from «Ещё» → back returns to «Ещё»', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    expect(heading()).toBe('Категории')
    act(() => nav.back())
    expect(nav.route).toEqual({ tab: 'more', screen: 'root' })
    expect(heading()).toBe('Ещё')
  })

  it('the NavBar «‹ …» pill goes back', () => {
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'limits' }))
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(heading()).toBe('Ещё')
  })

  it('«Расходы» from «Категории» go back to «Категории»; from «Отчёт» — to «Отчёт»', () => {
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    act(() => nav.push({ tab: 'more', screen: 'records', month: '2026-10', category: 'c1', from: 'cats' }))
    expect(heading()).toBe('Расходы')
    act(() => nav.back())
    expect(nav.route).toEqual({ tab: 'more', screen: 'cats' })

    act(() => nav.switchTab('report'))
    act(() => nav.push({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' }))
    expect(activeTab()).toBe('Отчёт')
    act(() => nav.back())
    expect(nav.route).toEqual({ tab: 'report', screen: 'root' })
    expect(heading()).toBe('Отчёт')
  })

  it('back() on a tab root does nothing', () => {
    setup()
    act(() => nav.back())
    expect(nav.route).toEqual({ tab: 'home', screen: 'root' })
  })

  it('«Ещё» stays highlighted on limits, accounts, categories, archive and on «Расходы» from «Категории»', () => {
    setup()
    act(() => nav.switchTab('more'))
    for (const s of ['limits', 'accounts', 'cats', 'archive'] as const) {
      act(() => nav.push({ tab: 'more', screen: s }))
      expect(heading()).toBe(TITLES[s])
      expect(activeTab()).toBe('Ещё')
      act(() => nav.back())
    }
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    act(() => nav.push({ tab: 'more', screen: 'records', month: '2026-10', category: 'c1', from: 'cats' }))
    expect(activeTab()).toBe('Ещё')
  })

  it('depths: tabs 0; calendar, limits, accounts, categories, archive 1; «Расходы» 2', () => {
    expect(depthOf({ tab: 'home', screen: 'root' })).toBe(0)
    for (const s of ['calendar', 'limits', 'accounts', 'cats', 'archive'] as const) expect(depthOf({ tab: 'more', screen: s })).toBe(1)
    expect(depthOf({ tab: 'more', screen: 'records', month: '2026-10', category: 'c1', from: 'cats' })).toBe(2)
  })

  it('animates deeper as a push, back as a pop, between tabs as a lift', () => {
    const { container } = setup()
    const scr = () => container.querySelector('.screen')!
    act(() => nav.switchTab('more'))
    expect(scr().className).toContain('v-tab')
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    expect(scr().className).toContain('v-push')
    act(() => nav.back())
    expect(scr().className).toContain('v-pop')
  })
})

describe('back swipe', () => {
  // Reduce Motion: the spring lands on its target at once, so the test does not wait for frames.
  const reduceMotion = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }))

  function swipe(el: Element, fromX: number, toX: number) {
    fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 300 }] })
    fireEvent.touchMove(el, { touches: [{ clientX: fromX + 20, clientY: 302 }] })
    fireEvent.touchMove(el, { touches: [{ clientX: toX, clientY: 305 }] })
    fireEvent.touchEnd(el, { touches: [] })
  }

  it('a swipe right over 60 % of the width goes back', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    const W = window.innerWidth
    swipe(screen.getByTestId('body'), 60, 60 + W * 0.6)
    await waitFor(() => expect(nav.route).toEqual({ tab: 'more', screen: 'root' }))
    expect(heading()).toBe('Ещё')
  })

  it('a swipe that starts on a swipeable row does not go back', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    const W = window.innerWidth
    swipe(screen.getByTestId('row'), 60, 60 + W * 0.6)
    await new Promise((r) => setTimeout(r, 20))
    expect(nav.route).toEqual({ tab: 'more', screen: 'cats' })
  })

  it('a field blocks it too, but not from the left edge (28 px)', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'limits' }))
    const W = window.innerWidth
    swipe(screen.getByLabelText('Поле'), 60, 60 + W * 0.6)
    await new Promise((r) => setTimeout(r, 20))
    expect(nav.route.screen).toBe('limits')

    swipe(screen.getByLabelText('Поле'), 10, 10 + W * 0.6)
    await waitFor(() => expect(nav.route.screen).toBe('root'))
  })

  it('a short slow drag springs back and stays', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    const el = screen.getByTestId('body')
    const t0 = performance.now()
    vi.spyOn(performance, 'now').mockImplementation(() => t0) // all samples at once would read as a flick
    fireEvent.touchStart(el, { touches: [{ clientX: 60, clientY: 300 }] })
    vi.spyOn(performance, 'now').mockImplementation(() => t0 + 400)
    fireEvent.touchMove(el, { touches: [{ clientX: 80, clientY: 300 }] })
    vi.spyOn(performance, 'now').mockImplementation(() => t0 + 800)
    fireEvent.touchMove(el, { touches: [{ clientX: 90, clientY: 300 }] })
    vi.spyOn(performance, 'now').mockImplementation(() => t0 + 1600)
    fireEvent.touchMove(el, { touches: [{ clientX: 90, clientY: 300 }] })
    fireEvent.touchEnd(el, { touches: [] })
    vi.restoreAllMocks()
    await new Promise((r) => setTimeout(r, 20))
    expect(nav.route.screen).toBe('cats')
  })

  it('a quick drag to 30 %, held still, then lifted is not a flick: it stays', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    const el = screen.getByTestId('body')
    const W = window.innerWidth
    let now = performance.now()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fireEvent.touchStart(el, { touches: [{ clientX: 60, clientY: 300 }] })
    for (let i = 1; i <= 6; i++) {
      now += 16
      fireEvent.touchMove(el, { touches: [{ clientX: 60 + 20 + (W * 0.3 * i) / 6, clientY: 300 }] })
    }
    now += 300 // the finger rests, then lifts without another move
    fireEvent.touchEnd(el, { touches: [] })
    vi.restoreAllMocks()
    await new Promise((r) => setTimeout(r, 20))
    expect(nav.route.screen).toBe('cats')
  })

  it('is off on a tab root and while the record sheet is open', async () => {
    reduceMotion()
    setup()
    const W = window.innerWidth
    swipe(screen.getByTestId('body'), 60, 60 + W * 0.6)
    await new Promise((r) => setTimeout(r, 20))
    expect(nav.route).toEqual({ tab: 'home', screen: 'root' })

    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    document.documentElement.dataset.editing = '1'
    try {
      swipe(screen.getByTestId('body'), 60, 60 + W * 0.6)
      await new Promise((r) => setTimeout(r, 20))
      expect(nav.route.screen).toBe('cats')
    } finally {
      delete document.documentElement.dataset.editing
    }
  })
})

describe('NavBar', () => {
  it('shows «‹ label», the 32 pt large title and a hidden compact title', () => {
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'archive' }))
    expect(screen.getByRole('button', { name: 'Назад' }).className).toContain('navback')
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.className).toContain('large')
    const small = document.querySelector('.navtitle')!
    expect(small.textContent).toBe('Архив')
    expect(small.getAttribute('aria-hidden')).toBe('true')
  })
})
