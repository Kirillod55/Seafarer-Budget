import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** Stub screens: a NavBar with the route's title, a counter (local state), a swipeable row, a field, a switch. */
function Stub({ route }: { route: Route }) {
  nav = useNav()
  const [count, setCount] = useState(0)
  const title = route.screen === 'root' ? TAB_TITLES[route.tab] : TITLES[route.screen]
  return (
    <>
      <NavBar back={route.screen === 'root' ? undefined : { label: 'Ещё' }} title={title} />
      <button type="button" onClick={() => setCount((c) => c + 1)}>{`Счёт ${count}`}</button>
      <div data-swipe-row="" data-testid="row">
        строка
      </div>
      <input aria-label="Поле" />
      <button type="button" role="switch" aria-checked="false" aria-label="Тумблер" />
      <p data-testid="body">тело</p>
    </>
  )
}

function setup() {
  return render(<Navigator renderScreen={(route) => <Stub route={route} />} />)
}

/** The visible screen (lower ones stay mounted, hidden). */
const top = () => document.querySelector<HTMLElement>('.app > .screen:not(.below)')!
const inTop = () => within(top())
const heading = () => screen.getByRole('heading', { level: 1 }).textContent
const activeTab = () => screen.getByRole('button', { current: 'page' }).textContent
const toCats = () => {
  act(() => nav.switchTab('more'))
  act(() => nav.push({ tab: 'more', screen: 'cats' }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  it('the NavBar pill «‹ Ещё» (VoiceOver: «Назад, Ещё») goes back', () => {
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'limits' }))
    const pill = screen.getByRole('button', { name: 'Назад, Ещё' })
    expect(pill.textContent).toBe('Ещё')
    fireEvent.click(pill)
    expect(heading()).toBe('Ещё')
  })

  it('«Расходы» from «Категории» go back to «Категории»; from «Отчёт» — to «Отчёт»', () => {
    setup()
    toCats()
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
    setup()
    act(() => nav.switchTab('more'))
    expect(top().className).toContain('v-tab')
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    expect(top().className).toContain('v-push')
    act(() => nav.back())
    expect(top().className).toContain('v-pop')
  })

  it('a lower screen stays mounted, hidden and inert; its local state survives push and back', () => {
    setup()
    act(() => nav.switchTab('more'))
    fireEvent.click(inTop().getByRole('button', { name: 'Счёт 0' }))
    fireEvent.click(inTop().getByRole('button', { name: 'Счёт 1' }))
    const more = top()
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    expect(more.isConnected).toBe(true)
    expect(more.className).toContain('below')
    expect(more.hasAttribute('inert')).toBe(true)
    expect(more.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Счёт 2' })).toBeNull() // hidden from the accessibility tree
    act(() => nav.back())
    expect(top()).toBe(more) // the same element, not a fresh copy
    expect(inTop().getByRole('button', { name: 'Счёт 2' })).toBeTruthy()
  })

  it('back restores the scroll position of the page below, deeper than the viewport', () => {
    setup()
    act(() => nav.switchTab('more'))
    window.scrollTo(0, 2400)
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    expect(window.scrollY).toBe(0) // the new screen starts at the top
    const below = document.querySelector<HTMLElement>('.screen.below')!
    expect(below.scrollTop).toBe(2400) // and the page underneath keeps showing its spot (for the back swipe)
    act(() => nav.back())
    expect(window.scrollY).toBe(2400)
  })

  it('tapping the current tab from a deeper screen returns to its root with its scroll', () => {
    setup()
    act(() => nav.switchTab('more'))
    window.scrollTo(0, 900)
    act(() => nav.push({ tab: 'more', screen: 'cats' }))
    act(() => nav.push({ tab: 'more', screen: 'records', month: '2026-10', category: 'c1', from: 'cats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    expect(nav.route).toEqual({ tab: 'more', screen: 'root' })
    expect(document.querySelectorAll('.app > .screen')).toHaveLength(1)
    expect(window.scrollY).toBe(900)
  })

  it('moves focus to the new screen’s title on push and back', () => {
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'archive' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Архив' }))
    act(() => nav.back())
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Ещё' }))
  })
})

describe('back swipe', () => {
  // Reduce Motion: the spring lands on its target at once, so the test does not wait for frames.
  const reduceMotion = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }))
  const fakeFrames = () => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  const tx = (el: HTMLElement) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0)
  const pause = () => new Promise((r) => setTimeout(r, 20))
  const at = (x: number, y = 300) => [{ clientX: x, clientY: y }]

  function swipe(el: Element, fromX: number, toX: number) {
    fireEvent.touchStart(el, { touches: at(fromX) })
    fireEvent.touchMove(el, { touches: at(fromX + 20, 302) })
    fireEvent.touchMove(el, { touches: at(toX, 305) })
    fireEvent.touchEnd(el, { touches: [], changedTouches: at(toX, 305) })
  }

  it('a swipe right over 60 % of the width goes back', async () => {
    reduceMotion()
    setup()
    toCats()
    swipe(inTop().getByTestId('body'), 60, 60 + window.innerWidth * 0.6)
    await waitFor(() => expect(nav.route).toEqual({ tab: 'more', screen: 'root' }))
    expect(heading()).toBe('Ещё')
  })

  it('reveals the mounted page below while dragging, and hides it again when cancelled', async () => {
    reduceMotion()
    setup()
    toCats()
    const below = document.querySelector<HTMLElement>('.screen.below')!
    const body = inTop().getByTestId('body')
    fireEvent.touchStart(body, { touches: at(60) })
    fireEvent.touchMove(body, { touches: at(80) })
    fireEvent.touchMove(body, { touches: at(120) })
    expect(below.className).toContain('peek')
    expect(below.style.transform).toMatch(/translateX\(-\d/)
    expect(document.querySelectorAll('.app > .screen')).toHaveLength(2) // no second copy of it
    fireEvent.touchCancel(body, { touches: [], changedTouches: at(120) })
    await pause()
    expect(below.className).not.toContain('peek')
    expect(below.style.transform).toBe('')
  })

  it('a swipe that starts on a swipeable row does not go back', async () => {
    reduceMotion()
    setup()
    toCats()
    swipe(inTop().getByTestId('row'), 60, 60 + window.innerWidth * 0.6)
    await pause()
    expect(nav.route).toEqual({ tab: 'more', screen: 'cats' })
  })

  it('a field or a switch blocks it too, but not from the left edge (28 px)', async () => {
    reduceMotion()
    setup()
    act(() => nav.switchTab('more'))
    act(() => nav.push({ tab: 'more', screen: 'limits' }))
    const W = window.innerWidth
    swipe(inTop().getByLabelText('Поле'), 60, 60 + W * 0.6)
    swipe(inTop().getByRole('switch', { name: 'Тумблер' }), 60, 60 + W * 0.6)
    await pause()
    expect(nav.route.screen).toBe('limits')

    swipe(inTop().getByRole('switch', { name: 'Тумблер' }), 10, 10 + W * 0.6)
    await waitFor(() => expect(nav.route.screen).toBe('root'))
  })

  it('a vertical move does not start it', async () => {
    reduceMotion()
    setup()
    toCats()
    const body = inTop().getByTestId('body')
    fireEvent.touchStart(body, { touches: at(60, 300) })
    fireEvent.touchMove(body, { touches: at(70, 340) })
    fireEvent.touchMove(body, { touches: at(60 + window.innerWidth * 0.6, 360) })
    fireEvent.touchEnd(body, { touches: [], changedTouches: at(60 + window.innerWidth * 0.6, 360) })
    await pause()
    expect(nav.route.screen).toBe('cats')
    expect(top().style.transform).toBe('')
  })

  it('an open menu blocks it', async () => {
    reduceMotion()
    setup()
    toCats()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    try {
      swipe(inTop().getByTestId('body'), 60, 60 + window.innerWidth * 0.6)
      await pause()
      expect(nav.route.screen).toBe('cats')
    } finally {
      menu.remove()
    }
  })

  it('a short slow drag springs back and stays', async () => {
    reduceMotion()
    setup()
    toCats()
    const el = inTop().getByTestId('body')
    let now = performance.now()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fireEvent.touchStart(el, { touches: at(60) })
    now += 400
    fireEvent.touchMove(el, { touches: at(80) })
    now += 400
    fireEvent.touchMove(el, { touches: at(90) })
    now += 800
    fireEvent.touchEnd(el, { touches: [], changedTouches: at(90) })
    await pause()
    expect(nav.route.screen).toBe('cats')
  })

  it('a quick drag to 30 %, held still, then lifted is not a flick: it stays', async () => {
    reduceMotion()
    setup()
    toCats()
    const el = inTop().getByTestId('body')
    const W = window.innerWidth
    let now = performance.now()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fireEvent.touchStart(el, { touches: at(60) })
    let x = 60
    for (let i = 1; i <= 6; i++) {
      now += 16
      x = 60 + 20 + (W * 0.3 * i) / 6
      fireEvent.touchMove(el, { touches: at(x) })
    }
    now += 300 // the finger rests, then lifts where it was (touchend reports it in changedTouches)
    fireEvent.touchEnd(el, { touches: [], changedTouches: at(x) })
    await pause()
    expect(nav.route.screen).toBe('cats')
  })

  it('touchcancel springs back even past the threshold', async () => {
    reduceMotion()
    setup()
    toCats()
    const el = inTop().getByTestId('body')
    fireEvent.touchStart(el, { touches: at(60) })
    fireEvent.touchMove(el, { touches: at(80) })
    fireEvent.touchMove(el, { touches: at(80 + window.innerWidth * 0.7) })
    fireEvent.touchCancel(el, { touches: [], changedTouches: at(80 + window.innerWidth * 0.7) })
    await pause()
    expect(nav.route.screen).toBe('cats')
    expect(top().style.transform).toBe('')
  })

  it('a drag cancels a push animation still running, so the page follows the finger', () => {
    reduceMotion()
    setup()
    toCats()
    const cancel = vi.fn()
    const el = top()
    el.getAnimations = () => [{ cancel } as unknown as Animation]
    const body = inTop().getByTestId('body')
    fireEvent.touchStart(body, { touches: at(60) })
    fireEvent.touchMove(body, { touches: at(80) })
    expect(cancel).toHaveBeenCalled()
  })

  it('the spring home never goes past the left edge, and can be caught mid-flight', () => {
    fakeFrames()
    setup()
    toCats()
    const el = top()
    const body = inTop().getByTestId('body')
    // drag out to 90 px slowly, then flick back to 40 px fast: the spring home starts with a strong leftward speed
    fireEvent.touchStart(body, { touches: at(100) })
    fireEvent.touchMove(body, { touches: at(120) })
    vi.advanceTimersByTime(100)
    fireEvent.touchMove(body, { touches: at(200) })
    vi.advanceTimersByTime(100)
    fireEvent.touchMove(body, { touches: at(210) })
    vi.advanceTimersByTime(16)
    fireEvent.touchMove(body, { touches: at(160) })
    fireEvent.touchEnd(body, { touches: [], changedTouches: at(160) })
    const seen: number[] = []
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(16)
      seen.push(tx(el))
    }
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
    expect(seen.at(-1)).toBe(0)
    expect(nav.route.screen).toBe('cats')

    // a new drag: release slowly at ~40 px, then catch the spring and pull — the page follows from where it was
    fireEvent.touchStart(body, { touches: at(100) })
    fireEvent.touchMove(body, { touches: at(120) })
    vi.advanceTimersByTime(200)
    fireEvent.touchMove(body, { touches: at(160) })
    vi.advanceTimersByTime(200)
    fireEvent.touchEnd(body, { touches: [], changedTouches: at(160) })
    vi.advanceTimersByTime(48)
    const caught = tx(el)
    expect(caught).toBeGreaterThan(0)
    expect(caught).toBeLessThan(40)
    fireEvent.touchStart(body, { touches: at(200) })
    vi.advanceTimersByTime(200)
    expect(tx(el)).toBe(caught) // stopped where it was caught
    fireEvent.touchMove(body, { touches: at(250) })
    expect(tx(el)).toBeCloseTo(caught + 50, 5)
  })

  it('is off on a tab root and while the record sheet is open', async () => {
    reduceMotion()
    setup()
    const W = window.innerWidth
    swipe(inTop().getByTestId('body'), 60, 60 + W * 0.6)
    await pause()
    expect(nav.route).toEqual({ tab: 'home', screen: 'root' })

    toCats()
    document.documentElement.dataset.editing = '1'
    try {
      swipe(inTop().getByTestId('body'), 60, 60 + W * 0.6)
      await pause()
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
    expect(screen.getByRole('button', { name: 'Назад, Ещё' }).className).toContain('navback')
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.className).toContain('large')
    const small = top().querySelector('.navtitle')!
    expect(small.textContent).toBe('Архив')
    expect(small.getAttribute('aria-hidden')).toBe('true')
  })
})
