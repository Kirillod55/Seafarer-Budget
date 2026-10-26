import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Category, FxRate, Limit } from '@shared/types.ts'
import { Limits } from './Limits.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'
import { createSync, type Remote } from '../db/sync.ts'
import { Navigator } from '../nav/Navigator.tsx'
import { ToastHost } from '../ui/Toast.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let cafe: Category

/** Reduce Motion on: blocks swap at once. */
function reducedMotion() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-reduced-motion: reduce'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
}

async function seed() {
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 10000 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
}

/** An expense of `uah` hryvnia (= uah / 40 USD) in the cafe category on `date`. */
async function spend(uah: number, date = TEST_TODAY, categoryId: string | null = cafe.id) {
  const account = (await env.db.accounts.toCollection().first())!
  await env.repo.addTransaction({
    kind: 'expense',
    amount: uah,
    currency: 'UAH',
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: categoryId,
    date,
    note: '',
    source: 'app',
  })
}

const setLimit = (monthly_usd: number, category_id = cafe.id) =>
  env.repo.put<Limit>('limits', { category_id, monthly_usd, deleted_at: null, deleted_batch: null })

function renderLimits() {
  return renderWithApp(
    <>
      <Navigator renderScreen={() => <Limits />} />
      <ToastHost />
    </>,
    env,
  )
}

/** «Добавить» → the category in the menu → the amount → «Сохранить». */
async function addLimit(category: RegExp, amount: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
  fireEvent.click(await screen.findByLabelText('Категория'))
  fireEvent.click(await screen.findByRole('option', { name: category }))
  fireEvent.change(screen.getByLabelText('В месяц, $'), { target: { value: amount } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
}

beforeEach(() => {
  env = makeEnv()
  reducedMotion()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Лимиты', () => {
  it('«Добавить» Кафе $100: the form is fields one under another; the card shows the month spending and «В норме»', async () => {
    await seed()
    await spend(3000) // $75
    renderLimits()

    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    const form = within(await screen.findByRole('region', { name: 'Новый лимит' }))
    expect(form.getByLabelText('Категория')).toBeTruthy()
    expect(form.getByLabelText('В месяц, $')).toBeTruthy()
    expect(document.querySelector('.limform .grid2')).toBeNull() // no side-by-side fields
    fireEvent.click(form.getByLabelText('Категория'))
    fireEvent.click(await screen.findByRole('option', { name: /Кафе и рестораны/ }))
    fireEvent.change(form.getByLabelText('В месяц, $'), { target: { value: '100' } })
    fireEvent.click(form.getByRole('button', { name: 'Сохранить' }))

    const card = within(await screen.findByRole('region', { name: 'Кафе и рестораны' }))
    expect(card.getByText('$75')).toBeTruthy()
    expect(card.getByText('из $100 за октябрь')).toBeTruthy()
    expect(card.getByText('В норме')).toBeTruthy()
    const bar = card.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(bar.getAttribute('data-level')).toBe('ok')
    expect(screen.queryByRole('region', { name: 'Новый лимит' })).toBeNull()
    expect(await env.db.limits.toArray()).toMatchObject([
      { category_id: cafe.id, monthly_usd: 100, deleted: false, deleted_at: null, deleted_batch: null, dirty: 1 },
    ])
  })

  it.each([
    [3000, 'ok', 'В норме'], // 75 %
    [3200, 'warn', 'Почти всё'], // 80 %
    [4400, 'over', 'Превышен'], // 110 %
  ])('spending %i ₴ of a $100 limit: level %s, the pill «%s»', async (uah, level, pill) => {
    await seed()
    await spend(uah)
    await setLimit(100)
    renderLimits()

    const bar = await screen.findByRole('progressbar')
    expect(bar.getAttribute('data-level')).toBe(level)
    expect(bar.className).toContain(`level-${level}`)
    expect(screen.getByText(pill).className).toContain(`pill ${level}`)
  })

  it('only the current month counts, and a card per limited expense category is shown', async () => {
    await seed()
    await spend(4000, '2026-09-30') // last month
    await spend(400) // $10 this month
    await setLimit(100)
    renderLimits()

    expect(await screen.findByText('$10')).toBeTruthy()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('the category menu offers only expense categories without a limit', async () => {
    await seed()
    await setLimit(100)
    renderLimits()

    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    fireEvent.click(await screen.findByLabelText('Категория'))
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '')
    expect(names.some((n) => n.includes('Кафе и рестораны'))).toBe(false)
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => n.includes('Зарплата'))).toBe(false) // income categories never get a limit
  })

  it('a non-positive amount is refused with «Введите сумму»', async () => {
    await seed()
    renderLimits()
    await addLimit(/Кафе и рестораны/, '0')
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await env.db.limits.count()).toBe(0)
  })

  it('«Отмена» closes the new limit card', async () => {
    await seed()
    renderLimits()
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Новый лимит' })).toBeNull())
    expect(screen.getByText('Лимитов пока нет')).toBeTruthy()
  })

  it('tapping the category on a card edits the monthly amount in place', async () => {
    await seed()
    const limit = await setLimit(100)
    renderLimits()

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить лимит «Кафе и рестораны»' }))
    const amount = (await screen.findByLabelText('В месяц, $')) as HTMLInputElement
    expect(amount.value).toBe('100')
    fireEvent.change(amount, { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('из $150 за октябрь')).toBeTruthy()
    expect(await env.db.limits.get(limit.id)).toMatchObject({ monthly_usd: 150, deleted: false, dirty: 1 })
    expect(await env.db.limits.count()).toBe(1)
  })

  it('«Убрать» bins the limit with «Отменить»; «Отменить» brings it back', async () => {
    await seed()
    const limit = await setLimit(100)
    renderLimits()

    fireEvent.click(await screen.findByRole('button', { name: 'Убрать лимит «Кафе и рестораны»' }))
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(await screen.findByText('Лимит убран')).toBeTruthy()
    expect(await env.db.limits.get(limit.id)).toMatchObject({ deleted: false, deleted_at: expect.any(String), dirty: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByRole('progressbar')).toBeTruthy()
    expect(await env.db.limits.get(limit.id)).toMatchObject({ deleted_at: null })
  })

  it('a binned limit is reused for the same category: no duplicate row', async () => {
    await seed()
    const limit = await setLimit(100)
    await env.repo.remove('limits', limit.id)
    renderLimits()

    await addLimit(/Кафе и рестораны/, '80')

    expect(await screen.findByText('из $80 за октябрь')).toBeTruthy()
    expect(await env.db.limits.toArray()).toMatchObject([
      { id: limit.id, monthly_usd: 80, deleted: false, deleted_at: null, deleted_batch: null },
    ])
  })

  it('a limit deleted for good (1.0 / purged) is not reused: a new id is made and stays live after sync', async () => {
    await seed()
    const limit = await setLimit(100)
    // final deletion as 1.0 or the daily purge left it, already in sync with the server
    await env.db.limits.update(limit.id, { deleted: true, dirty: 0, rev: 5 })
    const server = new Map<string, Record<string, unknown>>([[limit.id, { ...(await env.db.limits.get(limit.id))!, rev: 5 }]])
    let rev = 10
    // like set_rev(): `deleted = true` is never undone
    const remote: Remote = {
      async push(_table, rows) {
        return rows.map((r) => {
          const row = r as Record<string, unknown> & { id: string }
          const stored = { ...row, rev: ++rev, deleted: server.get(row.id)?.deleted === true || row.deleted === true }
          server.set(row.id, stored)
          return {
            id: row.id,
            rev: stored.rev,
            deleted: stored.deleted,
            deleted_at: (row.deleted_at as string | null) ?? null,
            deleted_batch: (row.deleted_batch as string | null) ?? null,
          }
        })
      },
      pushColumns: async () => [],
      pull: async () => [],
      fxRates: async () => [],
      patchRates: async () => {},
    }
    renderLimits()

    await addLimit(/Кафе и рестораны/, '80')
    expect(await screen.findByText('из $80 за октябрь')).toBeTruthy()

    await createSync(env.db, remote).syncOnce()
    const live = (await env.db.limits.toArray()).filter((l) => l.category_id === cafe.id && !l.deleted && l.deleted_at === null)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ monthly_usd: 80, dirty: 0, deleted_batch: null })
    expect(live[0].id).not.toBe(limit.id)
    expect(await screen.findByText('из $80 за октябрь')).toBeTruthy()
  })

  it('a limit on an archived category is not shown; «Добавить» hides when every category has a limit', async () => {
    await seed()
    await setLimit(100)
    await env.repo.put<Category>('categories', { ...cafe, archived: true })
    renderLimits()

    await screen.findByRole('button', { name: 'Добавить' })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(within(document.body).queryByText(/Кафе и рестораны/)).toBeNull()

    for (const c of await env.db.categories.toArray()) if (c.kind === 'expense' && !c.archived) await setLimit(10, c.id)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Добавить' })).toBeNull())
  })
})
