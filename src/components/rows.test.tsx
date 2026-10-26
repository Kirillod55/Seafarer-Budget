import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { useApp, type AppContextValue } from '../context.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import { SwipeRow } from '../ui/SwipeRow.tsx'
import { ToastHost } from '../ui/Toast.tsx'
import { DayGroups } from './DayGroups.tsx'

const ROW_W = 375

let env: AppContextValue

/** Reduce Motion on: springs land at once (a microtask), rows collapse without waiting. */
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

const cafe: Category = {
  id: 'cat-cafe',
  deleted: false,
  name: 'Кафе и рестораны',
  kind: 'expense',
  icon: '☕',
  keywords: [],
  archived: false,
  sort: 1,
  color: null,
  glyph: null,
  deleted_at: null,
  deleted_batch: null,
}

const main: Account = { id: 'acc-main', deleted: false, name: 'Основной', aliases: [], is_default: true, archived: false, sort: 0 }

function tx(patch: Partial<Transaction> & { id: string }): Transaction {
  return {
    deleted: false,
    kind: 'expense',
    amount: 80,
    currency: 'UAH',
    rate_usd: 0.025,
    amount_usd: 2,
    rate_pending: false,
    account_id: main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cafe.id,
    date: TEST_TODAY,
    note: 'кофе',
    source: 'app',
    created_at: '2026-10-21T10:00:00.000Z',
    author: 'owner',
    archived: false,
    deleted_at: null,
    deleted_batch: null,
    ...patch,
  }
}

async function seed(rows: Transaction[]) {
  await env.db.categories.put({ ...cafe, dirty: 0 } as never)
  await env.db.accounts.put({ ...main, dirty: 0 } as never)
  await env.db.transactions.bulkPut(rows.map((r) => ({ ...r, dirty: 0 })) as never)
}

/** DayGroups over a live query, like a screen uses it, plus the toast host. */
function Live({ onOpen }: { onOpen(id: string): void }) {
  const { db } = useApp()
  const data = useLiveQuery(
    () => Promise.all([db.transactions.toArray(), db.categories.toArray(), db.accounts.toArray()]),
    [db],
  )
  return (
    <>
      {data && (
        <DayGroups
          txs={data[0]}
          categories={data[1]}
          accounts={data[2]}
          partnerName="Маша"
          today={TEST_TODAY}
          onOpen={onOpen}
        />
      )}
      <ToastHost />
    </>
  )
}

function setup() {
  const onOpen = vi.fn()
  renderWithApp(<Live onOpen={onOpen} />, env)
  return { onOpen }
}

/** The swipeable row whose subtitle is this note (or «Маша · <note>»). */
function rowOf(note: string): HTMLElement {
  const t2 = [...document.querySelectorAll('.t2')].find((e) => e.textContent === note || e.textContent?.endsWith(` · ${note}`))
  if (!t2) throw new Error(`no row «${note}»`)
  return t2.closest<HTMLElement>('[data-swipe-row]')!
}
const fgOf = (row: HTMLElement) => row.querySelector<HTMLElement>('.tx')!

/** A tap as a finger makes it: down, up, click. */
function tap(el: HTMLElement) {
  const p = { pointerId: 9, pointerType: 'touch', button: 0, clientX: 100, clientY: 20 }
  fireEvent.pointerDown(el, p)
  fireEvent.pointerUp(el, p)
  fireEvent.click(el, { detail: 1 })
}

/** A synthetic horizontal drag on the row's front: down, a few moves to `dx`, up (all in the same ms: no fling). */
function swipe(row: HTMLElement, dx: number, pointerType = 'touch') {
  const el = fgOf(row)
  const x0 = 340
  const p = { pointerId: 1, pointerType, button: 0, clientY: 20 }
  // one frozen instant: performance.now() has sub-ms resolution, and a few µs between samples would read as a fling
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(now)
  try {
    fireEvent.pointerDown(el, { ...p, clientX: x0 })
    for (let i = 1; i <= 6; i++) fireEvent.pointerMove(el, { ...p, clientX: x0 + (dx * i) / 6 })
    fireEvent.pointerUp(el, { ...p, clientX: x0 + dx })
  } finally {
    clock.mockRestore()
  }
}

const x = (row: HTMLElement) => fgOf(row).style.transform
const flush = () => act(async () => {})

const actionNames = (row: HTMLElement) =>
  within(row)
    .queryAllByRole('button')
    .filter((b) => b.classList.contains('act'))
    .map((b) => b.textContent)

let widthDesc: PropertyDescriptor | undefined

beforeEach(() => {
  env = makeEnv()
  reducedMotion(true)
  // jsdom has no layout: every element is as wide as a 375 px phone row
  widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => ROW_W })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc)
})

describe('TxRow and DayGroups', () => {
  it('her record shows her initial on the icon and «Маша · Кофе»; mine has no mark', async () => {
    await seed([
      tx({ id: 't1', author: 'partner', note: 'кофе' }),
      tx({ id: 't2', author: 'owner', note: 'обед', created_at: '2026-10-21T09:00:00.000Z' }),
    ])
    setup()

    const hers = await waitFor(() => rowOf('Кофе'))
    expect(hers.querySelector('.who')?.textContent).toBe('М')
    expect(hers.querySelector('.t2')?.textContent).toBe('Маша · Кофе')
    expect(hers.querySelector('.whon')?.textContent).toBe('Маша')

    const mine = rowOf('Обед')
    expect(mine.querySelector('.who')).toBeNull()
    expect(mine.querySelector('.t2')?.textContent).toBe('Обед')
  })

  it('amounts: USD first without «−», the original currency below; income green with «+»', async () => {
    await seed([
      tx({ id: 't1', amount: 80, currency: 'UAH', amount_usd: 1.94 }),
      tx({ id: 't2', kind: 'income', amount: 500, currency: 'USD', amount_usd: 500, rate_usd: 1, note: 'зарплата', category_id: null, created_at: '2026-10-21T08:00:00.000Z' }),
    ])
    setup()

    const spend = (await waitFor(() => rowOf('Кофе'))).querySelector('.a')!
    expect(spend.textContent).toBe('$1.94₴80')
    expect(spend.querySelector('small')?.textContent).toBe('₴80')
    expect(spend.classList.contains('inc')).toBe(false)

    const income = rowOf('Зарплата').querySelector('.a')!
    expect(income.textContent).toBe('+$500')
    expect(income.classList.contains('inc')).toBe(true)
  })

  it('groups by day, newest first: «Сегодня», «20 октября»; archived and deleted records are not listed', async () => {
    await seed([
      tx({ id: 't1', date: '2026-10-20', note: 'вчерашний' }),
      tx({ id: 't2', date: TEST_TODAY, note: 'сегодняшний' }),
      tx({ id: 't3', date: TEST_TODAY, note: 'в архиве', archived: true }),
      tx({ id: 't4', date: TEST_TODAY, note: 'в корзине', deleted_at: '2026-10-21T11:00:00.000Z', deleted_batch: 'b' }),
    ])
    setup()

    await screen.findByText('Сегодняшний')
    expect([...document.querySelectorAll('.section')].map((h) => h.textContent)).toEqual(['Сегодня', '20 октября'])
    expect(document.querySelectorAll('.group').length).toBe(2)
    expect(screen.queryByText('В архиве')).toBeNull()
    expect(screen.queryByText('В корзине')).toBeNull()
  })

  it('a synthetic swipe of 120 px opens three buttons: «Изменить», «В архив», «Удалить»', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))

    // hidden until the row is pulled
    expect(actionNames(row)).toEqual([])

    swipe(row, -120)
    await waitFor(() => expect(fgOf(row).style.transform).toBe('translateX(-222px)'))
    expect(actionNames(row)).toEqual(['Изменить', 'В архив', 'Удалить'])
    expect(row.classList.contains('swiping')).toBe(true)
  })

  it('tapping an open row closes it instead of opening the record; a tap on a closed row opens it', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))

    swipe(row, -120, 'mouse')
    await waitFor(() => expect(fgOf(row).style.transform).toBe('translateX(-222px)'))
    // the click a mouse sends at the end of its drag is not a tap: the row stays open
    fireEvent.click(fgOf(row), { detail: 1 })
    expect(fgOf(row).style.transform).toBe('translateX(-222px)')

    tap(fgOf(row))
    expect(onOpen).not.toHaveBeenCalled()
    await waitFor(() => expect(actionNames(row)).toEqual([]))
    expect(fgOf(row).style.transform).toBe('translateX(0px)')

    tap(fgOf(row))
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('«Изменить» opens the record', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))
    swipe(row, -120)
    fireEvent.click(await within(row).findByRole('button', { name: 'Изменить' }))
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('«В архив» takes the row off the list; «Отменить» on the toast brings it back', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    swipe(row, -120)
    fireEvent.click(await within(row).findByRole('button', { name: 'В архив' }))

    await waitFor(() => expect(screen.queryByText('Кофе')).toBeNull())
    expect((await env.db.transactions.get('t1'))!.archived).toBe(true)
    expect(await screen.findByText('Запись в архиве')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByText('Кофе')).toBeTruthy()
    expect((await env.db.transactions.get('t1'))!.archived).toBe(false)
  })

  it('«Удалить»: the row goes, deleted_at is set and sync is kicked; «Отменить» brings it back with deleted_at null', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    const kick = env.scheduler.kick as ReturnType<typeof vi.fn>
    kick.mockClear()

    swipe(row, -120)
    fireEvent.click(await within(row).findByRole('button', { name: 'Удалить' }))

    await waitFor(() => expect(screen.queryByText('Кофе')).toBeNull())
    const gone = (await env.db.transactions.get('t1'))!
    expect(gone.deleted_at).toBeTruthy()
    expect(gone.deleted_batch).toBeTruthy()
    expect(kick).toHaveBeenCalled()
    expect(screen.getByText('Запись удалена')).toBeTruthy()

    kick.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByText('Кофе')).toBeTruthy()
    const back = (await env.db.transactions.get('t1'))!
    expect(back.deleted_at).toBeNull()
    expect(back.deleted_batch).toBeNull()
    expect(kick).toHaveBeenCalled()
  })

  it('a swipe across 90 % of the width deletes the record (with «Отменить»)', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))

    swipe(row, -ROW_W * 0.9)

    await waitFor(() => expect(screen.queryByText('Кофе')).toBeNull())
    expect((await env.db.transactions.get('t1'))!.deleted_at).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Отменить' })).toBeTruthy()
  })

  it('with motion on, a full swipe slides the row off, collapses it, then deletes it', async () => {
    reducedMotion(false)
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))

    swipe(row, -ROW_W * 0.9)
    expect(row.classList.contains('full')).toBe(true)
    // the spring carries it to the full width, then the row folds away (height → 0) before the delete
    await waitFor(() => expect(row.classList.contains('collapse')).toBe(true))
    expect(fgOf(row).style.transform).toBe(`translateX(-${ROW_W}px)`)
    expect(row.style.height).toBe('0px')
    expect((await env.db.transactions.get('t1'))!.deleted_at).toBeNull()

    await waitFor(() => expect(screen.queryByText('Кофе')).toBeNull())
    expect((await env.db.transactions.get('t1'))!.deleted_at).toBeTruthy()
  })

  it('a long swipe that stays within «open + 40 px» only opens the row', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))

    // 0.6 × 375 = 225 < 222 + 40: not yet a full swipe
    swipe(row, -240)
    await waitFor(() => expect(fgOf(row).style.transform).toBe('translateX(-222px)'))
    expect((await env.db.transactions.get('t1'))!.deleted_at).toBeNull()
  })

  it('opening another row closes the open one; a vertical move never opens a row', async () => {
    await seed([tx({ id: 't1' }), tx({ id: 't2', note: 'обед', created_at: '2026-10-21T09:00:00.000Z' })])
    setup()
    const a = await waitFor(() => rowOf('Кофе'))
    const b = rowOf('Обед')

    swipe(a, -120)
    await waitFor(() => expect(fgOf(a).style.transform).toBe('translateX(-222px)'))
    swipe(b, -120)
    await waitFor(() => expect(fgOf(b).style.transform).toBe('translateX(-222px)'))
    await waitFor(() => expect(fgOf(a).style.transform).toBe('translateX(0px)'))

    // a mostly vertical drag (scrolling) leaves a closed row alone
    const el = fgOf(a)
    fireEvent.pointerDown(el, { pointerId: 2, button: 0, clientX: 300, clientY: 20 })
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 290, clientY: 60 })
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 200, clientY: 70 })
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 200, clientY: 70 })
    expect(a.classList.contains('swiping')).toBe(false)
  })

  it('every row carries data-swipe-row, so the back swipe leaves it alone', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    expect(row.hasAttribute('data-swipe-row')).toBe(true)
  })

  it('a record that appears later slides in with a spring; the first ones do not', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const first = await waitFor(() => rowOf('Кофе'))
    expect(first.classList.contains('row-in')).toBe(false)

    await act(async () => {
      await env.db.transactions.put({ ...tx({ id: 't2', note: 'обед', created_at: '2026-10-21T11:00:00.000Z' }), dirty: 0 } as never)
    })
    const added = await waitFor(() => rowOf('Обед'))
    expect(added.classList.contains('row-in')).toBe(true)
    expect(rowOf('Кофе').classList.contains('row-in')).toBe(false)
  })

  it('with nothing to show says «Записей пока нет»', async () => {
    await seed([])
    setup()
    expect(await screen.findByText('Записей пока нет')).toBeTruthy()
  })

  it('her record without a note says just «Маша»; a negative adjustment keeps the minus money() writes', async () => {
    await seed([
      tx({ id: 't1', author: 'partner', note: '' }),
      tx({ id: 't2', kind: 'adjustment', amount: -5, currency: 'USD', amount_usd: -5, rate_usd: 1, category_id: null, note: 'сверка', created_at: '2026-10-21T09:00:00.000Z' }),
    ])
    setup()
    const hers = await waitFor(() => rowOf('Маша'))
    expect(hers.querySelector('.t2')!.textContent).toBe('Маша')
    const adj = rowOf('Сверка').querySelector('.a')!
    expect(adj.textContent).toBe('-$5')
    expect(adj.classList.contains('inc')).toBe(false)
  })
})

describe('SwipeRow while it moves (Reduce Motion off: real springs)', () => {
  beforeEach(() => reducedMotion(false))

  it('a tap while the row is still opening closes it and does not open the record', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))

    swipe(row, -120)
    expect(x(row)).toBe('translateX(-120px)') // released; the opening spring has not landed yet
    tap(fgOf(row))
    expect(onOpen).not.toHaveBeenCalled()
    await waitFor(() => expect(actionNames(row)).toEqual([]))
    expect(x(row)).toBe('translateX(0px)')
  })

  it('a tap while the row is closing lets it close fully; the record opens only from a closed row', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))
    swipe(row, -120)
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))

    tap(fgOf(row)) // starts closing
    tap(fgOf(row)) // lands mid-way
    expect(onOpen).not.toHaveBeenCalled()
    await waitFor(() => expect(actionNames(row)).toEqual([]))
    expect(x(row)).toBe('translateX(0px)')

    tap(fgOf(row))
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('a tap during the full-swipe slide is ignored: the delete still runs, the record does not open', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))

    swipe(row, -ROW_W * 0.9)
    tap(fgOf(row))
    swipe(row, 200) // nor can a drag catch it
    expect(onOpen).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.queryByText('Кофе')).toBeNull())
    expect((await env.db.transactions.get('t1'))!.deleted_at).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('never two open rows: opening a second row while the first is still opening closes the first', async () => {
    await seed([tx({ id: 't1' }), tx({ id: 't2', note: 'обед', created_at: '2026-10-21T09:00:00.000Z' })])
    setup()
    const a = await waitFor(() => rowOf('Кофе'))
    const b = rowOf('Обед')

    swipe(a, -120)
    swipe(b, -120)
    await waitFor(() => expect(x(b)).toBe('translateX(-222px)'))
    await waitFor(() => expect(x(a)).toBe('translateX(0px)'))
    await waitFor(() => expect(document.querySelectorAll('.swipe.swiping').length).toBe(1))
    expect(b.classList.contains('swiping')).toBe(true)

    // a tap on the closed row only closes the open one
    tap(fgOf(a))
    await waitFor(() => expect(x(b)).toBe('translateX(0px)'))
  })
})

describe('SwipeRow input', () => {
  it('keyboard: ArrowLeft opens the row and focuses «Изменить»; Esc closes it and returns focus to the row', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    const fg = fgOf(row)
    const acts = row.querySelector('.acts')!

    fg.focus()
    fireEvent.keyDown(fg, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Изменить'))
    expect(acts.hasAttribute('inert')).toBe(false)
    expect(acts.getAttribute('aria-hidden')).toBe('false')
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(fg)
    await waitFor(() => expect(acts.hasAttribute('inert')).toBe(true))
    expect(x(row)).toBe('translateX(0px)')

    // the context-menu key opens it too
    fireEvent.keyDown(fg, { key: 'ContextMenu' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Изменить'))
  })

  it('a keyboard or screen-reader activation is never taken for the end of a drag', async () => {
    await seed([tx({ id: 't1' })])
    const { onOpen } = setup()
    const row = await waitFor(() => rowOf('Кофе'))

    // a short mouse drag that springs back: the mouse's own click would be swallowed…
    swipe(row, -40, 'mouse')
    await flush()
    expect(x(row)).toBe('translateX(0px)')
    // …but Enter / VoiceOver (a click with detail 0) opens the record
    fireEvent.click(fgOf(row), { detail: 0 })
    expect(onOpen).toHaveBeenCalledWith('t1')

    // after a touch drag nothing is swallowed at all
    onOpen.mockClear()
    swipe(row, -40, 'touch')
    await flush()
    fireEvent.click(fgOf(row), { detail: 1 })
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  it('a second finger is ignored', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    const el = fgOf(row)
    const f1 = { pointerId: 1, pointerType: 'touch', button: 0, clientY: 20 }
    const f2 = { pointerId: 2, pointerType: 'touch', button: 0, clientY: 20 }

    fireEvent.pointerDown(el, { ...f1, clientX: 340 })
    fireEvent.pointerDown(el, { ...f2, clientX: 200 })
    fireEvent.pointerMove(el, { ...f2, clientX: 40 })
    expect(row.classList.contains('swiping')).toBe(false)
    expect(x(row)).toBe('')

    fireEvent.pointerMove(el, { ...f1, clientX: 280 })
    fireEvent.pointerMove(el, { ...f1, clientX: 220 })
    expect(x(row)).toBe('translateX(-120px)')
    fireEvent.pointerUp(el, { ...f2, clientX: 40 }) // the second finger lifting changes nothing
    expect(x(row)).toBe('translateX(-120px)')
    fireEvent.pointerUp(el, { ...f1, clientX: 220 })
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))
  })
})

describe('SwipeRow, fix round 2', () => {
  it('a mouse pressed on the row, moved off it and released outside does not lock the row', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    const el = fgOf(row)
    const mouse = { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 20 }

    fireEvent.pointerDown(el, { ...mouse, clientX: 200 })
    fireEvent.pointerMove(el, { ...mouse, clientX: 202, clientY: 60 }) // mostly vertical: not a swipe
    fireEvent.pointerLeave(el, { ...mouse, clientX: 202, clientY: 90 })
    fireEvent.pointerUp(document.body, { ...mouse, clientX: 202, clientY: 90 }) // released outside the row

    swipe(row, -120, 'mouse')
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))
  })

  it('the same pointer going down again starts afresh, even if its release was never seen', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    fireEvent.pointerDown(fgOf(row), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 20 })
    // no up, no leave reaches the row
    swipe(row, -120, 'mouse')
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))
  })

  it('a touch that left the row before dragging is forgotten: the next finger can swipe', async () => {
    await seed([tx({ id: 't1' })])
    setup()
    const row = await waitFor(() => rowOf('Кофе'))
    const el = fgOf(row)
    fireEvent.pointerDown(el, { pointerId: 7, pointerType: 'touch', button: 0, clientX: 200, clientY: 20 })
    fireEvent.pointerLeave(el, { pointerId: 7, pointerType: 'touch', clientX: 200, clientY: 20 })

    swipe(row, -120) // pointerId 1
    await waitFor(() => expect(x(row)).toBe('translateX(-222px)'))
  })

  it('an action that throws never leaves the row collapsed and deaf: it comes back and swipes again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const actions = [
        { key: 'edit' as const, label: 'Изменить', run: vi.fn() },
        {
          key: 'delete' as const,
          label: 'Удалить',
          run: () => {
            throw new Error('boom')
          },
        },
      ]
      render(
        <div className="days">
          <SwipeRow actions={actions} onOpen={vi.fn()}>
            <span className="t2">Ломается</span>
          </SwipeRow>
        </div>,
      )
      const row = rowOf('Ломается')
      swipe(row, -120)
      await waitFor(() => expect(x(row)).toBe('translateX(-168px)')) // two actions: 2 × 84
      fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
      expect(error).toHaveBeenCalled()

      // after the restore delay the row is back at rest and takes input again
      await waitFor(() => expect(x(row)).toBe('translateX(0px)'), { timeout: 3000 })
      expect(row.classList.contains('collapse')).toBe(false)
      swipe(row, -120)
      await waitFor(() => expect(x(row)).toBe('translateX(-168px)'))
    } finally {
      error.mockRestore()
    }
  })

  it('«В архив» from the keyboard moves focus to the next row, or the previous one for the last row', async () => {
    await seed([
      tx({ id: 't1', note: 'первая', created_at: '2026-10-21T11:00:00.000Z' }),
      tx({ id: 't2', note: 'вторая', created_at: '2026-10-21T10:00:00.000Z' }),
      tx({ id: 't3', note: 'третья', date: '2026-10-20' }),
    ])
    setup()
    const first = await waitFor(() => rowOf('Первая'))

    fgOf(first).focus()
    fireEvent.keyDown(fgOf(first), { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Изменить'))
    fireEvent.click(within(first).getByRole('button', { name: 'В архив' }), { detail: 0 })
    expect(document.activeElement).toBe(fgOf(rowOf('Вторая')))
    await waitFor(() => expect(screen.queryByText('Первая')).toBeNull())

    // the last row (in the next day's card) hands focus back to the row before it
    const last = rowOf('Третья')
    fgOf(last).focus()
    fireEvent.keyDown(fgOf(last), { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Изменить'))
    fireEvent.click(within(last).getByRole('button', { name: 'Удалить' }), { detail: 0 })
    expect(document.activeElement).toBe(fgOf(rowOf('Вторая')))
  })

  it('a negative adjustment in another currency shows the minus on both lines', async () => {
    await seed([
      tx({ id: 't1', kind: 'adjustment', amount: -200, currency: 'UAH', amount_usd: -4.85, category_id: null, note: 'сверка' }),
    ])
    setup()
    const a = (await waitFor(() => rowOf('Сверка'))).querySelector('.a')!
    expect(a.firstChild?.textContent).toBe('-$4.85')
    expect(a.querySelector('small')?.textContent).toBe('-₴200')
  })
})
