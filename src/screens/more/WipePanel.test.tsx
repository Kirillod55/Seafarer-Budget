import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alive } from '@shared/alive.ts'
import { money } from '@shared/format.ts'
import { selectForWipe } from '@shared/wipe.ts'
import type { Account, Category, Settings as SettingsRow } from '@shared/types.ts'
import { More } from '../More.tsx'
import { Navigator, type Route } from '../../nav/Navigator.tsx'
import { ToastHost } from '../../ui/Toast.tsx'
import { plural } from '../../ui/dates.ts'
import { TEST_TODAY, makeEnv, renderWithApp } from '../../test-utils.tsx'
import type { AppContextValue } from '../../context.tsx'

let env: AppContextValue
let main: Account
let cafe: Category
let salary: Category
let downloads: { name: string; blob: Blob }[]

const day = (k: number) => {
  const d = new Date(`${TEST_TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + k)
  return d.toISOString().slice(0, 10)
}

async function seed() {
  await env.db.fx_rates.bulkPut([{ date: day(-40), currency: 'USD', uah_per_unit: 41.5 }, { date: day(-40), currency: 'UAH', uah_per_unit: 1 }])
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 50000 }])
  main = (await env.db.accounts.toCollection().first())!
  const cats = await env.db.categories.toArray()
  cafe = cats.find((c) => c.name === 'Кафе и рестораны')!
  salary = cats.find((c) => c.name === 'Зарплата')!
}

const add = (kind: 'expense' | 'income', amount: number, date: string, currency = 'UAH') =>
  env.repo.addTransaction({
    kind,
    amount,
    currency,
    account_id: main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: kind === 'expense' ? cafe.id : salary.id,
    date,
    note: '',
    source: 'app',
    author: 'owner',
  })

/** Expenses today, 29 and 30 days ago (the edge of «Месяц»), one tomorrow, an income today and one in USD. */
async function seedRecords() {
  await add('expense', 100, TEST_TODAY)
  await add('expense', 250.5, day(-29))
  await add('expense', 40, day(-30))
  await add('expense', 10, day(1))
  await add('expense', 5, day(-3), 'USD')
  await add('income', 1000, TEST_TODAY)
}

const renderMore = () =>
  renderWithApp(
    <>
      <Navigator renderScreen={(r: Route) => (r.screen === 'root' ? <More onSignOut={vi.fn()} /> : <p>Экран {r.screen}</p>)} />
      <ToastHost />
    </>,
    env,
  )
const wipeCard = () => screen.findByRole('region', { name: 'Удаление данных' })

async function openRecords() {
  const card = await wipeCard()
  fireEvent.click(await within(card).findByRole('button', { name: 'Удалить записи…' }))
  return within(card).findByRole('group', { name: 'Удалить записи' })
}

beforeEach(() => {
  env = makeEnv()
  downloads = []
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      downloads.push({ name: '', blob: b })
      return 'blob:fake'
    }),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads[downloads.length - 1].name = this.download
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('«Удаление данных» → «Удалить записи…»', () => {
  it('«Месяц / Траты» counts exactly as selectForWipe and shows the dates in words', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    const txs = (await env.db.transactions.toArray()).filter(alive)
    const chosen = selectForWipe(txs, 'month', 'expense', TEST_TODAY)
    expect(chosen).toHaveLength(3) // today, −29 days and the USD one; not −30, not tomorrow
    const usd = chosen.reduce((s, t) => s + t.amount_usd, 0)
    expect(within(panel).getByRole('group', { name: 'Период' }).querySelector('[aria-pressed="true"]')!.textContent).toBe('Месяц')
    expect(within(panel).getByRole('group', { name: 'Что удалить' }).querySelector('[aria-pressed="true"]')!.textContent).toBe('Траты')
    expect(within(panel).getByText('22 сентября — 21 октября')).toBeTruthy()
    expect(panel.querySelector('.wsum')!.textContent).toBe(`Удалю ${plural(3, 'запись', 'записи', 'записей')} · траты ${money(usd, 'USD')}`)
    expect(within(panel).getByRole('button', { name: 'Удалить 3 записи' })).toBeTruthy()
    expect((within(panel).getByRole('checkbox', { name: 'Сначала скачать копию (CSV)' }) as HTMLInputElement).checked).toBe(true)
    expect(
      within(panel).getByText('Баланс изменится: удалённые траты больше не вычитаются, доходы не прибавляются. 24 часа удалённое можно вернуть.'),
    ).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Сутки' }))
    expect(within(panel).getByText('сегодня, 21 октября')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Доходы' }))
    expect(panel.querySelector('.wsum')!.textContent).toBe(`Удалю 1 запись · доходы ${money(selectForWipe(txs, 'day', 'income', TEST_TODAY)[0].amount_usd, 'USD')}`)
    fireEvent.click(within(panel).getByRole('button', { name: 'Неделя' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Траты' }))
    expect(within(panel).getByText('15 октября — 21 октября')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Всё время' }))
    expect(within(panel).getByText('все записи с самого начала')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Удалить 4 записи' })).toBeTruthy()
  })

  it('a period without such records says so and the button is inactive', async () => {
    await seed()
    renderMore()
    const panel = await openRecords()
    expect(panel.querySelector('.wsum')!.textContent).toBe('За этот период таких записей нет')
    expect((within(panel).getByRole('button', { name: 'Удалять нечего' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('switching the period does not remount the card or the screen header', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    const title = screen.getByRole('heading', { level: 1, name: 'Ещё' })
    const h3 = screen.getByRole('heading', { name: 'Удаление данных' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Неделя' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Всё' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Ещё' })).toBe(title)
    expect(screen.getByRole('heading', { name: 'Удаление данных' })).toBe(h3)
    expect(screen.getByRole('group', { name: 'Удалить записи' })).toBe(panel)
  })

  it('one press only arms the button; after 4 s it comes back and nothing is deleted', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(within(panel).getByRole('button', { name: 'Удалить 3 записи' }))
    const armed = within(panel).getByRole('button', { name: 'Нажми ещё раз — удалить' })
    expect(armed.classList.contains('armed')).toBe(true)
    act(() => vi.advanceTimersByTime(3900))
    expect(within(panel).getByRole('button', { name: 'Нажми ещё раз — удалить' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(200))
    expect(within(panel).getByRole('button', { name: 'Удалить 3 записи' }).classList.contains('armed')).toBe(false)
    vi.useRealTimers()
    expect((await env.db.transactions.toArray()).filter((t) => t.deleted_at)).toEqual([])
    expect(downloads).toEqual([])
  })

  it('a change of the period disarms the button', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    fireEvent.click(within(panel).getByRole('button', { name: 'Удалить 3 записи' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Всё время' }))
    expect(within(panel).getByRole('button', { name: 'Удалить 4 записи' })).toBeTruthy()
  })

  it('the second press deletes (with a CSV copy), shows the toast and «Вернуть удалённое»; «Вернуть» brings back the same ids', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    const ids = selectForWipe((await env.db.transactions.toArray()).filter(alive), 'month', 'expense', TEST_TODAY)
      .map((t) => t.id)
      .sort()
    fireEvent.click(within(panel).getByRole('button', { name: 'Удалить 3 записи' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Нажми ещё раз — удалить' }))

    expect(await screen.findByText('Удалено 3 записи')).toBeTruthy()
    const binned = (await env.db.transactions.toArray()).filter((t) => t.deleted_at)
    expect(binned.map((t) => t.id).sort()).toEqual(ids)
    // the copy of what was deleted, downloaded before the deletion
    expect(downloads).toHaveLength(1)
    expect(downloads[0].name).toBe('seafarer-budget-udalennye-2026-10-21.csv')
    const text = await downloads[0].blob.text()
    expect(text.trim().split('\r\n')).toHaveLength(4) // header + 3 rows

    const card = await wipeCard()
    await within(card).findByText('Удалено: 3 записи. Вернуть можно до 22 октября, 15:00')
    expect(within(card).queryByRole('group', { name: 'Удалить записи' })).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Вернуть удалённое' }))
    await waitFor(async () => expect((await env.db.transactions.toArray()).filter((t) => t.deleted_at)).toEqual([]))
    const back = (await env.db.transactions.bulkGet(ids)).map((t) => t!.deleted_at)
    expect(back).toEqual([null, null, null])
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Вернуть удалённое' })).toBeNull())
  })

  it('the toast «Вернуть» restores too; without the tick no file is saved', async () => {
    await seed()
    await seedRecords()
    renderMore()
    const panel = await openRecords()
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Сначала скачать копию (CSV)' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Удалить 3 записи' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Нажми ещё раз — удалить' }))
    const toast = (await screen.findByText('Удалено 3 записи')).closest('.toast') as HTMLElement
    expect(downloads).toEqual([])
    fireEvent.click(within(toast).getByRole('button', { name: 'Вернуть' }))
    await waitFor(async () => expect((await env.db.transactions.toArray()).filter((t) => t.deleted_at)).toEqual([]))
  })

  it('«Отмена» closes the panel', async () => {
    await seed()
    renderMore()
    const panel = await openRecords()
    fireEvent.click(within(panel).getByRole('button', { name: 'Отмена' }))
    const card = await wipeCard()
    await waitFor(() => expect(within(card).queryByRole('group', { name: 'Удалить записи' })).toBeNull())
    expect(within(card).getByRole('button', { name: 'Удалить записи…' })).toBeTruthy()
  })
})

describe('«Удаление данных» → «Удалить все данные…»', () => {
  it('bins records, goals, limits and own categories, keeps settings and accounts, then opens the wizard at «Остаток»', async () => {
    await seed()
    await seedRecords()
    await env.repo.put<SettingsRow>('settings', { id: (await env.db.settings.toCollection().first())!.id, reserve_usd: 500 })
    const settingsBefore = (await env.db.settings.toCollection().first())!
    const initDefaults = vi.spyOn(env.repo, 'initDefaults')
    renderMore()
    const card = await wipeCard()
    fireEvent.click(await within(card).findByRole('button', { name: 'Удалить все данные…' }))
    const panel = await within(card).findByRole('group', { name: 'Удалить все данные' })
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Сначала скачать копию (CSV)' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Удалить все данные' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Нажми ещё раз — удалить' }))

    expect(await screen.findByRole('heading', { name: 'Сколько денег сейчас' })).toBeTruthy()
    expect((await env.db.transactions.toArray()).filter(alive)).toEqual([])
    expect((await env.db.accounts.toArray()).filter(alive)).toHaveLength(1)
    expect((await env.db.settings.toCollection().first())!.reserve_usd).toBe(settingsBefore.reserve_usd)

    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '700' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Сколько денег сейчас' })).toBeNull())
    const live = (await env.db.transactions.toArray()).filter(alive)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ kind: 'adjustment', amount: 700, note: 'Начальный остаток' })
    expect(initDefaults).not.toHaveBeenCalled()
    expect(await within(await wipeCard()).findByText(/^Удалено: все данные\. Вернуть можно до/)).toBeTruthy()
  })
})
