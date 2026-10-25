import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category } from '@shared/types.ts'
import { CategoryIcon } from './CategoryIcon.tsx'
import { Morph } from './Morph.tsx'
import { PartnerBadge } from './PartnerBadge.tsx'
import { Picker, type PickerOption } from './Picker.tsx'
import { ProgressBar } from './ProgressBar.tsx'
import { Segmented } from './Segmented.tsx'
import { ToastHost, useToast } from './Toast.tsx'
import { useCountUp } from './useCountUp.ts'
import { useFlip } from './useFlip.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** iPhone «Уменьшение движения» on or off for the code under test. */
function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q.includes('prefers-reduced-motion: reduce'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
}

/** Run with a stubbed Element.prototype.animate, restoring jsdom's (absent) one even when the test fails. */
function withAnimate<T>(stub: (this: Element, ...a: Parameters<Element['animate']>) => unknown, body: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'animate')
  const prev = Element.prototype.animate
  Element.prototype.animate = stub as Element['animate']
  try {
    return body()
  } finally {
    if (had) Element.prototype.animate = prev
    // @ts-expect-error — jsdom has no Web Animations: take the stub away again
    else delete Element.prototype.animate
  }
}

const fakeAnim = () => ({ onfinish: null, oncancel: null, cancel() {} }) as unknown as Animation

describe('Segmented', () => {
  function Demo({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState('expense')
    return (
      <Segmented
        label="Тип записи"
        options={[
          { value: 'expense', label: 'Расход' },
          { value: 'income', label: 'Доход' },
        ]}
        value={v}
        onChange={(x) => {
          setV(x)
          onChange?.(x)
        }}
      />
    )
  }

  it('marks the chosen option with aria-pressed and moves it on a tap', () => {
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Тип записи' })
    expect(group).toBeTruthy()
    const exp = screen.getByRole('button', { name: 'Расход' })
    const inc = screen.getByRole('button', { name: 'Доход' })
    expect(exp.getAttribute('aria-pressed')).toBe('true')
    expect(inc.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(inc)
    expect(onChange).toHaveBeenCalledWith('income')
    expect(exp.getAttribute('aria-pressed')).toBe('false')
    expect(inc.getAttribute('aria-pressed')).toBe('true')
    // the lime pill is one decorative element, hidden from screen readers
    expect(group.querySelectorAll('.thumb[aria-hidden="true"]')).toHaveLength(1)
  })
})

describe('Picker', () => {
  const ACCS: PickerOption[] = [
    { value: 'main', label: 'Основной', sub: '≈ $1,475' },
    { value: 'cash', label: 'Наличные', sub: '≈ $3,650' },
    { value: 'old', label: 'Старая карта' },
  ]

  function Demo({ options = ACCS, kind, allowOther, onChange, onAdd }: {
    options?: PickerOption[]
    kind?: 'currency' | 'category' | 'account'
    allowOther?: boolean
    onChange?: (v: string) => void
    onAdd?: (code: string) => void
  }) {
    const [v, setV] = useState(options[0].value)
    return (
      <Picker
        id="p"
        label="Откуда"
        value={v}
        options={options}
        kind={kind}
        allowOther={allowOther}
        onAdd={onAdd}
        onChange={(x) => {
          setV(x)
          onChange?.(x)
        }}
      />
    )
  }

  it('opens on a click as a glass menu with a tick at the chosen item', () => {
    render(<Demo />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.textContent).toContain('Основной')

    fireEvent.click(btn)
    const menu = screen.getByRole('listbox', { name: 'Откуда' })
    // the overlay blocks the back swipe (nav: .glass) and lives on <body>
    expect(menu.classList.contains('glass')).toBe(true)
    expect(menu.parentElement).toBe(document.body)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const opts = screen.getAllByRole('option')
    expect(opts).toHaveLength(3)
    expect(opts[0].getAttribute('aria-selected')).toBe('true')
    expect(opts[0].querySelector('.chk svg')).toBeTruthy()
    expect(opts[1].querySelector('.chk svg')).toBeNull()
    expect(opts[0].textContent).toContain('≈ $1,475')
    // focus starts on the chosen item
    expect(document.activeElement).toBe(opts[0])
  })

  it('arrow down + Enter chooses the next item and closes the menu', () => {
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    fireEvent.click(btn)
    const menu = screen.getByRole('listbox')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('option')[1])
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('cash')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(btn.textContent).toContain('Наличные')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('arrow up wraps around to the last item', () => {
    render(<Demo />)
    fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getAllByRole('option')[2])
  })

  it('Esc closes the menu and gives the focus back to the field', () => {
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    fireEvent.click(btn)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(btn)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a tap outside the menu closes it without choosing', () => {
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
    fireEvent.click(document.querySelector('.pick-catch')!)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Откуда/ }))
  })

  it('arrow down or up on the closed field opens the menu', () => {
    render(<Demo />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    fireEvent.keyDown(btn, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(btn, { key: 'ArrowUp' })
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('a menu that fits on neither side goes to the larger side with its height cut, scrolling inside', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 300,
      bottom: 348,
      left: 16,
      right: 359,
      width: 343,
      height: 48,
      x: 16,
      y: 300,
      toJSON() {},
    } as DOMRect)
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900)
    try {
      render(<Demo />)
      fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
      const menu = screen.getByRole('listbox')
      // window 768: 404 px below the field (8 px gaps), 284 above → below, cut to 404
      expect(innerHeight).toBe(768)
      expect(menu.style.maxHeight).toBe('404px')
      expect(menu.style.top).toBe('356px')
      expect(menu.style.getPropertyValue('--oy')).toBe('0%')
    } finally {
      rect.mockRestore()
      tall.mockRestore()
    }
  })

  it('a menu that fits above but not below opens above the field', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 600,
      bottom: 648,
      left: 16,
      right: 359,
      width: 343,
      height: 48,
      x: 16,
      y: 600,
      toJSON() {},
    } as DOMRect)
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    try {
      render(<Demo />)
      fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
      const menu = screen.getByRole('listbox')
      expect(menu.style.top).toBe('392px')
      expect(menu.style.maxHeight).toBe('')
      expect(menu.style.getPropertyValue('--oy')).toBe('100%')
    } finally {
      rect.mockRestore()
      h.mockRestore()
    }
  })

  it('a click on an item chooses it', () => {
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
    fireEvent.click(screen.getByRole('option', { name: /Старая карта/ }))
    expect(onChange).toHaveBeenCalledWith('old')
  })

  const CURS: PickerOption[] = [
    { value: 'USD', label: 'USD $' },
    { value: 'UAH', label: 'UAH ₴' },
  ]

  it('currency menu: round badge with the sign, bold code and its name under it', () => {
    render(<Demo options={CURS} kind="currency" />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    expect(btn.querySelector('.cbadge')?.textContent).toBe('$')
    fireEvent.click(btn)
    const uah = screen.getAllByRole('option')[1]
    expect(uah.querySelector('.cbadge')?.textContent).toBe('₴')
    expect(uah.querySelector('.cnm b')?.textContent).toBe('UAH')
    expect(uah.querySelector('.cnm small')?.textContent).toBe('Гривна')
    // no «Другая валюта…» unless asked for
    expect(screen.queryByRole('option', { name: /Другая валюта/ })).toBeNull()
  })

  it('«Другая валюта…»: wrong code shows a red hint; «gel» becomes GEL, is chosen and joins the list', () => {
    const onChange = vi.fn()
    const onAdd = vi.fn()
    render(<Demo options={CURS} kind="currency" allowOther onChange={onChange} onAdd={onAdd} />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('option', { name: /Другая валюта/ }))

    const dialog = screen.getByRole('dialog', { name: 'Другая валюта' })
    expect(dialog.classList.contains('glass')).toBe(true)
    const input = screen.getByLabelText('Код валюты') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ge1' } })
    expect(input.value).toBe('GE')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(dialog.querySelector('.co-hint.err')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'gel' } })
    expect(input.value).toBe('GEL')
    // typing again clears the error
    expect(input.getAttribute('aria-invalid')).toBe('false')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('GEL')
    expect(onAdd).toHaveBeenCalledWith('GEL')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(btn.querySelector('.cbadge')?.textContent).toBe('₾')
    expect(btn.textContent).toContain('GEL')
    expect(document.activeElement).toBe(btn)

    fireEvent.click(btn)
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.querySelector('.cnm b')?.textContent)).toEqual(['USD', 'UAH', 'GEL', 'Другая валюта…'])
    expect(opts[2].getAttribute('aria-selected')).toBe('true')
    expect(opts[2].querySelector('.cnm small')?.textContent).toBe('Грузинский лари')
  })

  it('«Добавить» button works like Enter; Esc in the code field closes it', () => {
    const onChange = vi.fn()
    render(<Demo options={CURS} kind="currency" allowOther onChange={onChange} />)
    const btn = screen.getByRole('button', { name: /Откуда/ })
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('option', { name: /Другая валюта/ }))
    fireEvent.change(screen.getByLabelText('Код валюты'), { target: { value: 'xyz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
    expect(onChange).toHaveBeenCalledWith('XYZ')

    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('option', { name: /Другая валюта/ }))
    fireEvent.keyDown(screen.getByLabelText('Код валюты'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('category menu shows the icon given with each option', () => {
    render(
      <Demo
        kind="category"
        options={[
          { value: 'a', label: 'Продукты', icon: <span data-testid="ic-a" /> },
          { value: 'b', label: 'Кафе', icon: <span data-testid="ic-b" /> },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Откуда/ }))
    expect(screen.getByRole('listbox').querySelector('[data-testid="ic-b"]')).toBeTruthy()
  })
})

describe('Toast', () => {
  function Trigger({ run }: { run?: () => void | Promise<unknown> }) {
    const toast = useToast()
    return (
      <button type="button" onClick={() => toast('Запись удалена', run ? { label: 'Отменить', run } : undefined)}>
        go
      </button>
    )
  }

  const toastEl = () => document.querySelector<HTMLElement>('.toast')

  function setup(run?: () => void | Promise<unknown>) {
    vi.useFakeTimers()
    render(
      <>
        <Trigger run={run} />
        <ToastHost />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    return toastEl()!
  }

  it('the live region is always on the page; the toast appears inside it', () => {
    vi.useFakeTimers()
    render(
      <>
        <Trigger />
        <ToastHost />
      </>,
    )
    const region = screen.getByRole('status')
    expect(region.parentElement).toBe(document.body)
    expect(region.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.querySelector('.toast')?.textContent).toBe('Запись удалена')
    act(() => void vi.advanceTimersByTime(6100))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('')
  })

  it('«Отменить» runs the action and closes the toast', () => {
    const run = vi.fn()
    const t = setup(run)
    expect(t.textContent).toContain('Запись удалена')
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(toastEl()).toBeNull()
  })

  it('an action that fails (rejected promise) says so', async () => {
    setup(() => Promise.reject(new Error('offline')))
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await act(async () => {})
    expect(toastEl()?.textContent).toBe('Не получилось — попробуй ещё раз')
  })

  it('an action that throws says so too', () => {
    setup(() => {
      throw new Error('boom')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(toastEl()?.textContent).toBe('Не получилось — попробуй ещё раз')
  })

  it('goes away after 6 s', () => {
    setup()
    act(() => void vi.advanceTimersByTime(5900))
    expect(toastEl()).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(toastEl()).toBeNull()
  })

  it('stays while a pointer is on it, then 2.5 s more', () => {
    const t = setup()
    fireEvent.pointerEnter(t)
    act(() => void vi.advanceTimersByTime(20_000))
    expect(toastEl()).toBeTruthy()
    fireEvent.pointerLeave(t)
    act(() => void vi.advanceTimersByTime(2400))
    expect(toastEl()).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(toastEl()).toBeNull()
  })

  it('a short touch early on does not cut the 6 s short', () => {
    const t = setup()
    act(() => void vi.advanceTimersByTime(1000))
    fireEvent.touchStart(t)
    act(() => void vi.advanceTimersByTime(500))
    fireEvent.touchEnd(t) // 4.5 s of the 6 are left
    act(() => void vi.advanceTimersByTime(4400))
    expect(toastEl()).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(toastEl()).toBeNull()
  })

  it('stays while a finger is on it', () => {
    const t = setup()
    fireEvent.touchStart(t)
    act(() => void vi.advanceTimersByTime(20_000))
    expect(toastEl()).toBeTruthy()
    fireEvent.touchEnd(t)
    act(() => void vi.advanceTimersByTime(2600))
    expect(toastEl()).toBeNull()
  })

  it('a new toast replaces the old one and restarts the 6 s', () => {
    setup()
    act(() => void vi.advanceTimersByTime(4000))
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    act(() => void vi.advanceTimersByTime(4000))
    expect(document.querySelectorAll('.toast')).toHaveLength(1)
    act(() => void vi.advanceTimersByTime(2100))
    expect(toastEl()).toBeNull()
  })
})

const cat = (over: Partial<Category>): Category => ({
  id: 'c1',
  user_id: 'u',
  name: 'Продукты',
  kind: 'expense',
  icon: '🛒',
  keywords: [],
  archived: false,
  sort: 0,
  color: null,
  glyph: null,
  deleted: false,
  updated_at: '2026-10-25T00:00:00Z',
  ...over,
} as Category)

describe('CategoryIcon', () => {
  it('a built-in category takes its built-in colour and glyph', () => {
    const { container } = render(<CategoryIcon category={cat({})} />)
    const tile = container.querySelector('.ic') as HTMLElement
    expect(tile.style.getPropertyValue('--c')).toBe('#30B455')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.querySelector('svg')).toBeTruthy()
    expect(tile.classList.contains('sm')).toBe(false)
  })

  it('the user’s own colour wins; size sm; a light colour gets a dark glyph (.lt)', () => {
    const { container } = render(<CategoryIcon category={cat({ name: 'Своя', color: '#FFCC00', glyph: 'gift' })} size="sm" />)
    const tile = container.querySelector('.ic') as HTMLElement
    expect(tile.style.getPropertyValue('--c')).toBe('#FFCC00')
    expect(tile.classList.contains('sm')).toBe(true)
    expect(tile.classList.contains('lt')).toBe(true)
  })

  it('a dark colour keeps the white glyph', () => {
    const { container } = render(<CategoryIcon category={cat({ name: 'Своя', color: '#0A84FF' })} />)
    expect(container.querySelector('.ic')!.classList.contains('lt')).toBe(false)
  })
})

describe('PartnerBadge', () => {
  it('a neutral circle with the first letter', () => {
    const { container } = render(<PartnerBadge name="маша" />)
    const b = container.querySelector('.who') as HTMLElement
    expect(b.textContent).toBe('М')
    expect(b.getAttribute('title')).toBe('маша')
  })
})

describe('ProgressBar', () => {
  it('reports its share in percent and its level', () => {
    render(<ProgressBar value={75} max={100} level="warn" />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(bar.getAttribute('data-level')).toBe('warn')
    expect(bar.className).toContain('level-warn')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('75%')
  })

  it('clamps to 0…100 % and copes with max 0', () => {
    const { rerender } = render(<ProgressBar value={150} max={100} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    rerender(<ProgressBar value={5} max={0} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('grows from 0 when it appears (0 % is laid out first, then the real width); not with Reduce Motion', () => {
    const seen: string[] = []
    const ow = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('bar-fill')) seen.push(this.style.width)
      return 0
    })
    try {
      reducedMotion(false)
      const { unmount } = render(<ProgressBar value={40} max={100} />)
      expect(seen).toEqual(['0%'])
      expect((document.querySelector('.bar-fill') as HTMLElement).style.width).toBe('40%')
      unmount()
      seen.length = 0
      reducedMotion(true)
      render(<ProgressBar value={40} max={100} />)
      expect(seen).toEqual([])
    } finally {
      ow.mockRestore()
    }
  })
})

describe('useCountUp', () => {
  it('with Reduce Motion gives the new value at once', () => {
    reducedMotion(true)
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 10 } })
    expect(result.current).toBe(10)
    rerender({ v: 250 })
    expect(result.current).toBe(250)
  })

  it('otherwise counts up over 0.6 s and lands exactly on the value', () => {
    reducedMotion(false)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 10 } })
    expect(result.current).toBe(10) // the first value shows as is
    rerender({ v: 110 })
    expect(result.current).toBe(10)
    act(() => void vi.advanceTimersByTime(300))
    expect(result.current).toBeGreaterThan(10)
    expect(result.current).toBeLessThan(110)
    act(() => void vi.advanceTimersByTime(400))
    expect(result.current).toBe(110)
  })
})

describe('Morph', () => {
  it('shows the new content in place of the old one', () => {
    const { rerender, container } = render(
      <Morph k="a">
        <p>Первое</p>
      </Morph>,
    )
    expect(screen.getByText('Первое')).toBeTruthy()
    rerender(
      <Morph k="b">
        <p>Второе</p>
      </Morph>,
    )
    expect(screen.getByText('Второе')).toBeTruthy()
    // jsdom has no Web Animations: the old layer goes at once
    expect(screen.queryByText('Первое')).toBeNull()
    expect(container.querySelectorAll('.mIn')).toHaveLength(1)
  })

  it('while animating, the old content stays as a hidden, inert layer', () => {
    const anims: Animation[] = []
    reducedMotion(false)
    withAnimate(
      () => {
        const a = fakeAnim()
        anims.push(a)
        return a
      },
      () => {
        const { rerender, container } = render(
          <Morph k="a">
            <p id="x">Первое</p>
          </Morph>,
        )
        rerender(
          <Morph k="b">
            <p>Второе</p>
          </Morph>,
        )
        const old = container.querySelector('.mOld') as HTMLElement
        expect(old.textContent).toBe('Первое')
        expect(old.getAttribute('aria-hidden')).toBe('true')
        expect(old.querySelector('[id]')).toBeNull()
        act(() => void anims[0].onfinish?.call(anims[0], {} as AnimationPlaybackEvent))
        expect(container.querySelector('.mOld')).toBeNull()
      },
    )
  })
})

describe('useFlip', () => {
  function List({ items }: { items: string[] }) {
    const ref = useRef<HTMLDivElement>(null)
    useFlip(ref, [items.join()])
    return (
      <div ref={ref} data-testid="box">
        <div className="navbar">шапка</div>
        {items.map((x) => (
          <section key={x} data-flip-key={x}>
            {x}
          </section>
        ))}
      </div>
    )
  }

  it('a removed block melts away in its place as a ghost; new blocks fade in', () => {
    reducedMotion(false)
    const animate = vi.fn(fakeAnim)
    withAnimate(animate, () => {
      const { rerender } = render(<List items={['A', 'B']} />)
      rerender(<List items={['B', 'C']} />)
      const ghost = document.querySelector('.flipghost') as HTMLElement
      expect(ghost.textContent).toBe('A')
      expect(ghost.hasAttribute('data-flip-key')).toBe(false)
      expect(ghost.style.pointerEvents).toBe('none')
      // C (new) fades in, A (ghost) fades out; B did not move in jsdom (no layout)
      expect(animate).toHaveBeenCalledTimes(2)
    })
  })

  it('a block below one that grows slides from where it stands at t=0, not from beyond the grown block', () => {
    // A tiny layout: blocks stack from the top of the box; Z and B are 40 tall, A grows 200 → 350. Its height
    // animation starts at the old 200, and (as in a browser) the layout follows the animated height.
    // A is tall once Z is gone (the same change)
    let aAnimating = false
    let zGone = false
    const height = (k: string) => (k === 'A' ? (zGone && !aAnimating ? 350 : 200) : 40)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = this.closest('[data-testid="box"]')
      const k = (this as HTMLElement).dataset?.flipKey
      let top = 0
      let h = 0
      if (box && k) {
        zGone = !box.querySelector(':scope > [data-flip-key="Z"]')
        for (const el of box.querySelectorAll<HTMLElement>(':scope > [data-flip-key]')) {
          if (el === this) {
            h = height(k)
            break
          }
          top += height(el.dataset.flipKey!)
        }
      }
      return { top, bottom: top + h, left: 0, right: 300, width: 300, height: h, x: 0, y: top, toJSON() {} } as DOMRect
    })
    const calls: { key: string; frames: Keyframe[]; easing?: string }[] = []
    try {
      reducedMotion(false)
      withAnimate(
        function (this: Element, frames, opts) {
          const key = (this as HTMLElement).dataset?.flipKey ?? ''
          const fr = frames as Keyframe[]
          calls.push({ key, frames: fr, easing: (opts as KeyframeAnimationOptions | undefined)?.easing })
          if (key === 'A' && fr[0].height) aAnimating = true
          return fakeAnim()
        },
        () => {
          const { rerender } = render(<List items={['Z', 'A', 'B']} />)
          // in one change Z goes and A grows 200 → 350
          rerender(<List items={['A', 'B']} />)
        },
      )
    } finally {
      rect.mockRestore()
    }
    const grow = calls.find((c) => c.key === 'A' && c.frames[0].height)
    expect(grow?.frames).toEqual([{ height: '200px' }, { height: '350px' }])
    // B stood at 240 (Z 40 + A 200); at t=0 it is at 200 (Z gone, A back at 200): it slides 40 px up from there.
    // Measured against the final layout (A at 350) it would start at -110, on top of A.
    expect(calls.find((c) => c.key === 'B')?.frames[0]).toEqual({ transform: 'translateY(40px)' })
    // A itself moves up by Z's 40
    const slideA = calls.find((c) => c.key === 'A' && c.frames[0].transform)
    expect(slideA?.frames[0]).toEqual({ transform: 'translateY(40px)' })
    // the spec's iOS curve
    expect(slideA?.easing).toBe('cubic-bezier(.32,.72,0,1)')
  })

  it('does nothing with Reduce Motion', () => {
    reducedMotion(true)
    const animate = vi.fn(fakeAnim)
    withAnimate(animate, () => {
      const { rerender } = render(<List items={['A', 'B']} />)
      rerender(<List items={['B']} />)
      expect(document.querySelector('.flipghost')).toBeNull()
      expect(animate).not.toHaveBeenCalled()
    })
  })
})
