import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Transaction } from '@shared/types.ts'
import { useApp, type AppContextValue } from '../context.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
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
  fireEvent.pointerDown(el, { pointerId: 9, button: 0, clientX: 100, clientY: 20 })
  fireEvent.pointerUp(el, { pointerId: 9, button: 0, clientX: 100, clientY: 20 })
  fireEvent.click(el)
}

/** A synthetic horizontal drag on the row's front: down, a few moves to `dx`, up (all in the same ms: no fling). */
function swipe(row: HTMLElement, dx: number) {
  const el = fgOf(row)
  const x0 = 340
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x0, clientY: 20 })
  for (let i = 1; i <= 6; i++) fireEvent.pointerMove(el, { pointerId: 1, clientX: x0 + (dx * i) / 6, clientY: 20 })
  fireEvent.pointerUp(el, { pointerId: 1, clientX: x0 + dx, clientY: 20 })
}

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

    swipe(row, -120)
    await waitFor(() => expect(fgOf(row).style.transform).toBe('translateX(-222px)'))
    // the click a mouse sends at the end of the drag is not a tap: the row stays open
    fireEvent.click(fgOf(row))
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
    expect(screen.getByText('Запись в архиве')).toBeTruthy()

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
})
