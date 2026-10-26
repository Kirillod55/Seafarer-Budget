import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Settings as SettingsRow } from '@shared/types.ts'
import { RecordSheet } from './RecordSheet.tsx'
import { LegacyAccounts, LegacyCategories } from './LegacyManage.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// The 1.0 categories and accounts management, kept until Tasks 11 / 14 replace it (moved from Settings.test.tsx).

let env: AppContextValue
let main: Account
let cafe: Category

async function seed(mode: 'single' | 'multi' = 'single') {
  await env.repo.initDefaults(mode, [{ currency: 'UAH', amount: 5000 }])
  main = (await env.db.accounts.toCollection().first())!
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
}

/** Spend `uah` hryvnia so the UAH balance becomes 5000 - uah. */
async function spend(uah: number, categoryId: string | null = cafe.id) {
  return env.repo.addTransaction({
    kind: 'expense',
    amount: uah,
    currency: 'UAH',
    account_id: main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: categoryId,
    date: TEST_TODAY,
    note: 'кофе',
    source: 'app',
  })
}

const settingsRow = async () => (await env.db.settings.toCollection().first())!
const renderSettings = () => renderWithApp(<LegacyCategories />, env)
const renderAccounts = () => renderWithApp(<LegacyAccounts />, env)
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  env = makeEnv()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Legacy: categories', () => {
  it('renames a category and changes its icon', async () => {
    await seed()
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить категорию Кафе и рестораны' }))
    fireEvent.change(screen.getByLabelText('Название категории'), { target: { value: 'Кофейни' } })
    fireEvent.change(screen.getByLabelText('Иконка'), { target: { value: '🍵' } })
    click('Сохранить категорию')

    await waitFor(async () =>
      expect(await env.db.categories.get(cafe.id)).toMatchObject({ name: 'Кофейни', icon: '🍵', archived: false, dirty: 1 }),
    )
    expect(await screen.findByRole('button', { name: 'Изменить категорию Кофейни' })).toBeTruthy()
  })

  it('an empty name is rejected', async () => {
    await seed()
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить категорию Кафе и рестораны' }))
    fireEvent.change(screen.getByLabelText('Название категории'), { target: { value: '  ' } })
    click('Сохранить категорию')
    expect(await screen.findByText('Введите название')).toBeTruthy()
    expect((await env.db.categories.get(cafe.id))!.name).toBe('Кафе и рестораны')
  })

  it('archiving hides the category from the record picker; old records keep it; it can be restored', async () => {
    await seed()
    const old = await spend(80)
    const view = renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Архивировать категорию Кафе и рестораны' }))
    await waitFor(async () => expect((await env.db.categories.get(cafe.id))!.archived).toBe(true))
    expect((await env.db.transactions.get(old.id))!.category_id).toBe(cafe.id)

    view.unmount()
    renderWithApp(<RecordSheet open onClose={vi.fn()} />, env)
    const picker = await screen.findByRole('group', { name: 'Категория' })
    const names = within(picker)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
    expect(names).not.toContain('Кафе и рестораны')
    expect(names).toContain('Продукты')
  })

  it('an archived category is listed with «Вернуть», which unarchives it', async () => {
    await seed()
    await env.repo.put<Category>('categories', { ...cafe, archived: true })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть категорию Кафе и рестораны' }))
    await waitFor(async () => expect((await env.db.categories.get(cafe.id))!.archived).toBe(false))
  })

  it('«+ Категория» adds a category of the chosen kind with an icon at the end of the list', async () => {
    await seed()
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: '+ Категория' }))
    fireEvent.change(screen.getByLabelText('Название категории'), { target: { value: 'Подработка' } })
    fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'income' } })
    fireEvent.change(screen.getByLabelText('Иконка'), { target: { value: '🛠' } })
    click('Сохранить категорию')

    await waitFor(async () => {
      const created = (await env.db.categories.toArray()).find((c) => c.name === 'Подработка')
      expect(created).toMatchObject({ kind: 'income', icon: '🛠', archived: false, keywords: [], deleted: false, dirty: 1 })
      const sorts = (await env.db.categories.toArray()).map((c) => c.sort)
      expect(created!.sort).toBe(Math.max(...sorts))
      expect(new Set(sorts).size).toBe(sorts.length)
    })
  })

  it('a failing save shows «Не удалось сохранить»', async () => {
    await seed()
    renderSettings()
    vi.spyOn(env.repo, 'put').mockRejectedValue(new Error('boom'))
    fireEvent.click(await screen.findByRole('button', { name: 'Архивировать категорию Кафе и рестораны' }))
    expect(await screen.findByText('Не удалось сохранить')).toBeTruthy()
  })
})

describe('Legacy: accounts', () => {
  it('account management is shown in multi mode only', async () => {
    await seed('single')
    const view = renderAccounts()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('region', { name: 'Управление счетами' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Изменить счёт Основной' })).toBeNull()

    view.unmount()
    await env.repo.put<SettingsRow>('settings', { id: (await settingsRow()).id, accounts_mode: 'multi' })
    renderAccounts()
    expect(await screen.findByRole('region', { name: 'Управление счетами' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Изменить счёт Основной' })).toBeTruthy()
  })

  it('renames an account and stores its aliases', async () => {
    await seed('multi')
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить счёт Основной' }))
    fireEvent.change(screen.getByLabelText('Название счёта'), { target: { value: 'Моно' } })
    fireEvent.change(screen.getByLabelText('Псевдонимы (через запятую)'), { target: { value: 'карта, mono , ' } })
    click('Сохранить счёт')

    await waitFor(async () =>
      expect(await env.db.accounts.get(main.id)).toMatchObject({ name: 'Моно', aliases: ['карта', 'mono'], dirty: 1 }),
    )
  })

  it('the default account cannot be archived; another can, and is restorable', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    renderAccounts()

    const defaultBtn = (await screen.findByRole('button', { name: 'Архивировать счёт Основной' })) as HTMLButtonElement
    expect(defaultBtn.disabled).toBe(true)

    click('Архивировать счёт Наличные')
    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(true))
    expect((await env.db.accounts.get(main.id))!.archived).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть счёт Наличные' }))
    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(false))
  })

  it('the last remaining account cannot be archived even if it is not marked default', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.put<Account>('accounts', { ...main, archived: true, is_default: false })
    renderAccounts()

    const btn = (await screen.findByRole('button', { name: 'Архивировать счёт Наличные' })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect((await env.db.accounts.get(cash.id))!.archived).toBe(false)
  })
})
