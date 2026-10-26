import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Author, Settings } from '@shared/types.ts'
import { Records } from './Records.tsx'
import { RecordSheetHost } from './RecordSheet.tsx'
import { NavBar } from '../nav/NavBar.tsx'
import { Navigator, useNav, type Route } from '../nav/Navigator.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// TEST_TODAY is 2026-10-21.
let env: AppContextValue
let accountId: string
const cat: Record<string, string> = {}
let nav: ReturnType<typeof useNav>

async function expense(amount: number, date: string, category: string, note: string, extra: { author?: Author; archived?: boolean } = {}) {
  return env.repo.addTransaction({
    kind: 'expense',
    amount,
    currency: 'USD',
    account_id: accountId,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cat[category],
    date,
    note,
    source: 'app',
    author: extra.author ?? 'owner',
    archived: extra.archived ?? false,
  })
}

function Root() {
  nav = useNav()
  return <NavBar title="Категории" />
}

function renderAt(route: Route) {
  const r = renderWithApp(
    <RecordSheetHost>
      <Navigator renderScreen={(x) => (x.screen === 'records' ? <Records /> : <Root />)} />
    </RecordSheetHost>,
    env,
  )
  act(() => nav.push(route))
  return r
}

const top = () => document.querySelector<HTMLElement>('.app > .screen:not(.below)')!

beforeEach(async () => {
  env = makeEnv()
  await env.repo.initDefaults('single', [])
  accountId = (await env.db.accounts.toCollection().first())!.id
  for (const c of await env.db.categories.toArray()) cat[c.name] = c.id
  const s = (await env.db.settings.toCollection().first())!
  await env.repo.put<Settings>('settings', { id: s.id, partner_name: 'Маша' })
})

describe('Records («Расходы»)', () => {
  it('from «Категории»: the category icon and name are the title, «‹ Категории» goes back', async () => {
    await expense(12, '2026-10-05', 'Продукты', 'хлеб')
    await expense(40, '2026-10-06', 'Транспорт и такси', 'такси')
    renderAt({ tab: 'more', screen: 'records', month: '2026-10', category: cat['Продукты'], from: 'cats' })

    const h1 = await screen.findByRole('heading', { level: 1, name: 'Продукты' })
    expect(h1.querySelector('.ic')).toBeTruthy()
    await waitFor(() => expect(within(top()).getByText('Хлеб')).toBeTruthy())
    expect(within(top()).queryByText('Такси')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Назад, Категории' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Категории' })).toBeTruthy()
  })

  it('an income category from «Категории» lists its incomes', async () => {
    await env.repo.addTransaction({
      kind: 'income',
      amount: 900,
      currency: 'USD',
      account_id: accountId,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: cat['Зарплата'],
      date: '2026-10-05',
      note: 'аванс',
      source: 'app',
    })
    renderAt({ tab: 'more', screen: 'records', month: '2026-10', category: cat['Зарплата'], from: 'cats' })
    await waitFor(() => expect(within(top()).getByText('Аванс')).toBeTruthy())
  })

  it('from the report without a category: «Расходы», «‹ Отчёт»', async () => {
    renderAt({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Расходы' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Назад, Отчёт' })).toBeTruthy()
    expect(await within(top()).findByText('Трат в октябре нет')).toBeTruthy()
  })

  it('an archived expense is in the sum but not in the list: «… · 1 из них в архиве»', async () => {
    await expense(10, '2026-10-05', 'Продукты', 'хлеб')
    await expense(20.5, '2026-10-07', 'Продукты', 'сыр')
    await expense(5, '2026-10-07', 'Продукты', 'тайное', { archived: true })
    renderAt({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })

    expect(await within(top()).findByText('3 записи на $35.50 · 1 из них в архиве')).toBeTruthy()
    expect(within(top()).getByText('Сыр')).toBeTruthy()
    expect(within(top()).queryByText('Тайное')).toBeNull()
  })

  it('days go newest first, each with its sum on the right', async () => {
    await expense(10, '2026-10-05', 'Продукты', 'хлеб')
    await expense(20, '2026-10-07', 'Продукты', 'сыр')
    await expense(3, '2026-10-07', 'Продукты', 'вода')
    await expense(99, '2026-09-30', 'Продукты', 'сентябрь')
    renderAt({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })

    await waitFor(() => expect(top().querySelectorAll('.daygroup')).toHaveLength(2))
    const heads = [...top().querySelectorAll('.daygroup .dsec')].map((h) => h.textContent)
    expect(heads).toEqual(['7 октября$23', '5 октября$10'])
    expect(within(top()).queryByText('Сентябрь')).toBeNull()
  })

  it('«Все / Я / Маша» filters the records and the line', async () => {
    await expense(10, '2026-10-05', 'Продукты', 'хлеб')
    await expense(30, '2026-10-06', 'Кафе и рестораны', 'кофе', { author: 'partner' })
    renderAt({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })

    expect(await within(top()).findByText('2 записи на $40')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Маша' }))
    expect(await within(top()).findByText('1 запись на $30')).toBeTruthy()
    expect(within(top()).queryByText('Хлеб')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Я' }))
    expect(await within(top()).findByText('1 запись на $10')).toBeTruthy()
    expect(within(top()).queryByText('Кофе')).toBeNull()
  })

  it('‹ › page the month', async () => {
    await expense(10, '2026-10-05', 'Продукты', 'хлеб')
    await expense(99, '2026-09-30', 'Продукты', 'рынок')
    renderAt({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })

    expect(await within(top()).findByText('Октябрь 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сентябрь' }))
    expect(await within(top()).findByText('Сентябрь 2026')).toBeTruthy()
    expect(await within(top()).findByText('1 запись на $99')).toBeTruthy()
    expect(within(top()).getByText('Рынок')).toBeTruthy()
  })
})
