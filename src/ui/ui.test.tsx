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

  function Demo({ options = ACCS, kind, allowOther, onChange }: {
    options?: PickerOption[]
    kind?: 'currency' | 'category' | 'account'
    allowOther?: boolean
    onChange?: (v: string) => void
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
    render(<Demo options={CURS} kind="currency" allowOther onChange={onChange} />)
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
  function Trigger({ run }: { run?: () => void }) {
    const toast = useToast()
    return (
      <button type="button" onClick={() => toast('Запись удалена', run ? { label: 'Отменить', run } : undefined)}>
        go
      </button>
    )
  }

  function setup(run?: () => void) {
    vi.useFakeTimers()
    render(
      <>
        <Trigger run={run} />
        <ToastHost />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    return screen.getByRole('status')
  }

  it('«Отменить» runs the action and closes the toast', () => {
    const run = vi.fn()
    const t = setup(run)
    expect(t.textContent).toContain('Запись удалена')
    expect(t.parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('goes away after 6 s', () => {
    setup()
    act(() => void vi.advanceTimersByTime(5900))
    expect(screen.queryByRole('status')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays while a pointer is on it, then 2.5 s more', () => {
    const t = setup()
    fireEvent.pointerEnter(t)
    act(() => void vi.advanceTimersByTime(20_000))
    expect(screen.queryByRole('status')).toBeTruthy()
    fireEvent.pointerLeave(t)
    act(() => void vi.advanceTimersByTime(2400))
    expect(screen.queryByRole('status')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays while a finger is on it', () => {
    const t = setup()
    fireEvent.touchStart(t)
    act(() => void vi.advanceTimersByTime(20_000))
    expect(screen.queryByRole('status')).toBeTruthy()
    fireEvent.touchEnd(t)
    act(() => void vi.advanceTimersByTime(2600))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a new toast replaces the old one and restarts the 6 s', () => {
    setup()
    act(() => void vi.advanceTimersByTime(4000))
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    act(() => void vi.advanceTimersByTime(4000))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    act(() => void vi.advanceTimersByTime(2100))
    expect(screen.queryByRole('status')).toBeNull()
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
    const anims: { onfinish: (() => void) | null }[] = []
    Element.prototype.animate = vi.fn(() => {
      const a = { onfinish: null, oncancel: null, cancel() {} }
      anims.push(a)
      return a as unknown as Animation
    })
    reducedMotion(false)
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
    act(() => anims[0].onfinish?.())
    expect(container.querySelector('.mOld')).toBeNull()
    // @ts-expect-error — remove the stub again
    delete Element.prototype.animate
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
    const animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel() {} }) as unknown as Animation)
    Element.prototype.animate = animate
    const { rerender } = render(<List items={['A', 'B']} />)
    rerender(<List items={['B', 'C']} />)
    const ghost = document.querySelector('.flipghost') as HTMLElement
    expect(ghost.textContent).toBe('A')
    expect(ghost.hasAttribute('data-flip-key')).toBe(false)
    expect(ghost.style.pointerEvents).toBe('none')
    // C (new) fades in, A (ghost) fades out; B did not move in jsdom (no layout)
    expect(animate).toHaveBeenCalledTimes(2)
    // @ts-expect-error — remove the stub again
    delete Element.prototype.animate
  })

  it('does nothing with Reduce Motion', () => {
    reducedMotion(true)
    const animate = vi.fn()
    Element.prototype.animate = animate
    const { rerender } = render(<List items={['A', 'B']} />)
    rerender(<List items={['B']} />)
    expect(document.querySelector('.flipghost')).toBeNull()
    expect(animate).not.toHaveBeenCalled()
    // @ts-expect-error — remove the stub again
    delete Element.prototype.animate
  })
})
