import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Settings as SettingsRow } from '@shared/types.ts'
import { RecordScreen } from './Record.tsx'
import { Settings } from './Settings.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

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
const renderSettings = (onSignOut = vi.fn()) => renderWithApp(<Settings onSignOut={onSignOut} />, env)
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  env = makeEnv()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Settings: accounts mode', () => {
  it('single → multi → single keeps every account and transaction', async () => {
    await seed()
    await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await spend(80)
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Несколько счетов' }))
    await waitFor(async () => expect((await settingsRow()).accounts_mode).toBe('multi'))
    click('Один счёт')
    await waitFor(async () => expect((await settingsRow()).accounts_mode).toBe('single'))

    expect(await env.db.accounts.filter((a) => !a.deleted).count()).toBe(2)
    expect(await env.db.transactions.filter((t) => !t.deleted).count()).toBe(2) // opening balance + expense
  })
})

describe('Settings: status', () => {
  it('«В рейсе» stores the contract dates; switching back to «Дома» keeps them and stores the home dates', async () => {
    await seed()
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'В рейсе' }))
    await waitFor(async () => expect((await settingsRow()).status).toBe('contract'))
    fireEvent.change(await screen.findByLabelText('Начало контракта'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('Конец контракта'), { target: { value: '2027-03-01' } })
    click('Сохранить даты')
    await waitFor(async () => expect((await settingsRow()).contract_end_date).toBe('2027-03-01'))

    click('Дома')
    await waitFor(async () => expect((await settingsRow()).status).toBe('home'))
    await waitFor(() => expect(screen.queryByLabelText('Начало контракта')).toBeNull())
    fireEvent.change(await screen.findByLabelText('Следующий контракт'), { target: { value: '2027-04-15' } })
    fireEvent.change(screen.getByLabelText('Задержка зарплаты, дней'), { target: { value: '45' } })
    click('Сохранить даты')

    await waitFor(async () =>
      expect(await settingsRow()).toMatchObject({
        status: 'home',
        next_contract_date: '2027-04-15',
        salary_lag_days: 45,
        contract_start_date: '2026-09-01',
        contract_end_date: '2027-03-01',
        dirty: 1,
      }),
    )

    click('В рейсе')
    expect((await screen.findByLabelText('Начало контракта') as HTMLInputElement).value).toBe('2026-09-01')
    expect((screen.getByLabelText('Конец контракта') as HTMLInputElement).value).toBe('2027-03-01')
  })

  it('a salary lag that is not a whole non-negative number is rejected', async () => {
    await seed()
    renderSettings()
    await screen.findByLabelText('Задержка зарплаты, дней')
    fireEvent.change(screen.getByLabelText('Задержка зарплаты, дней'), { target: { value: '-3' } })
    click('Сохранить даты')
    expect(await screen.findByText('Введите число дней')).toBeTruthy()
    expect((await settingsRow()).salary_lag_days).toBe(30)
  })
})

describe('Settings: currencies', () => {
  it('adds PLN to the list (lowercase input is uppercased)', async () => {
    await seed()
    renderSettings()

    fireEvent.change(await screen.findByLabelText('Новая валюта'), { target: { value: 'pln' } })
    click('Добавить валюту')

    await waitFor(async () => expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR', 'MDL', 'PLN']))
    expect(await screen.findByRole('button', { name: 'Убрать валюту PLN' })).toBeTruthy()
    expect((screen.getByLabelText('Новая валюта') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Курс берётся у НБУ — валюта должна быть в его списке')).toBeTruthy()
  })

  it.each(['PL', 'PLNN', '12A', 'ЗЛТ', ''])('rejects the code «%s»', async (code) => {
    await seed()
    renderSettings()
    fireEvent.change(await screen.findByLabelText('Новая валюта'), { target: { value: code } })
    click('Добавить валюту')
    expect(await screen.findByText('Код валюты — 3 латинские буквы')).toBeTruthy()
    expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR', 'MDL'])
  })

  it('rejects a currency that is already in the list', async () => {
    await seed()
    renderSettings()
    fireEvent.change(await screen.findByLabelText('Новая валюта'), { target: { value: 'eur' } })
    click('Добавить валюту')
    expect(await screen.findByText('Такая валюта уже есть')).toBeTruthy()
  })

  it('the base (USD) and the default (UAH) currencies cannot be removed; another one can', async () => {
    await seed()
    renderSettings()

    await screen.findByLabelText('Новая валюта')
    expect(screen.queryByRole('button', { name: 'Убрать валюту USD' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Убрать валюту UAH' })).toBeNull()

    click('Убрать валюту MDL')
    await waitFor(async () => expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR']))
  })

  it('the default currency can be changed, and the new default is then protected', async () => {
    await seed()
    renderSettings()

    fireEvent.change(await screen.findByLabelText('Валюта по умолчанию'), { target: { value: 'EUR' } })
    await waitFor(async () => expect((await settingsRow()).default_currency).toBe('EUR'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Убрать валюту EUR' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Убрать валюту UAH' })).toBeTruthy()
  })
})

describe('Settings: «Сверка»', () => {
  it('balance 4920 ₴, real 4800 ₴ creates an adjustment of −120 ₴ dated today', async () => {
    await seed()
    await spend(80)
    renderSettings()

    expect(await within(await screen.findByRole('region', { name: 'Сверка' })).findByText('4 920 ₴')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Реальный остаток UAH'), { target: { value: '4800' } })
    click('Сверить UAH')

    await waitFor(async () => {
      const adj = (await env.db.transactions.toArray()).filter((t) => t.kind === 'adjustment' && t.note === 'Сверка')
      expect(adj).toMatchObject([
        { amount: -120, currency: 'UAH', date: TEST_TODAY, category_id: null, account_id: main.id, deleted: false, dirty: 1 },
      ])
    })
    expect(await screen.findByText('4 800 ₴')).toBeTruthy()
  })

  it('a real amount above the balance creates a positive adjustment (decimal comma accepted)', async () => {
    await seed()
    renderSettings()
    fireEvent.change(await screen.findByLabelText('Реальный остаток UAH'), { target: { value: '5000,5' } })
    click('Сверить UAH')
    await waitFor(async () =>
      expect((await env.db.transactions.toArray()).find((t) => t.note === 'Сверка')).toMatchObject({ amount: 0.5 }),
    )
  })

  it('nothing is saved when the difference is 0', async () => {
    await seed()
    renderSettings()
    fireEvent.change(await screen.findByLabelText('Реальный остаток UAH'), { target: { value: '5000' } })
    click('Сверить UAH')
    expect(await screen.findByText('Баланс совпадает')).toBeTruthy()
    expect(await env.db.transactions.count()).toBe(1) // only the opening balance
  })

  it('an empty or non-numeric real amount is rejected', async () => {
    await seed()
    renderSettings()
    await screen.findByLabelText('Реальный остаток UAH')
    click('Сверить UAH')
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Реальный остаток UAH'), { target: { value: 'abc' } })
    click('Сверить UAH')
    expect(await env.db.transactions.count()).toBe(1)
  })

  it('multi mode reconciles per account and currency', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.addTransaction({
      kind: 'income', amount: 100, currency: 'USD', account_id: cash.id, to_account_id: null, to_amount: null,
      to_currency: null, category_id: null, date: TEST_TODAY, note: '', source: 'app',
    })
    renderSettings()

    fireEvent.change(await screen.findByLabelText('Реальный остаток Наличные USD'), { target: { value: '90' } })
    click('Сверить Наличные USD')

    await waitFor(async () =>
      expect((await env.db.transactions.toArray()).find((t) => t.note === 'Сверка')).toMatchObject({
        amount: -10,
        currency: 'USD',
        account_id: cash.id,
      }),
    )
    // the main account is untouched
    expect((await env.db.transactions.toArray()).filter((t) => t.note === 'Сверка')).toHaveLength(1)
  })

  it('a failing save shows «Не удалось сохранить»', async () => {
    await seed()
    renderSettings()
    vi.spyOn(env.repo, 'addTransaction').mockRejectedValue(new Error('boom'))
    fireEvent.change(await screen.findByLabelText('Реальный остаток UAH'), { target: { value: '10' } })
    click('Сверить UAH')
    expect(await screen.findByText('Не удалось сохранить')).toBeTruthy()
  })
})

describe('Settings: categories', () => {
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
    renderWithApp(<RecordScreen onDone={vi.fn()} />, env)
    const picker = (await screen.findByLabelText('Категория')) as HTMLSelectElement
    expect([...picker.options].some((o) => (o.textContent ?? '').includes('Кафе и рестораны'))).toBe(false)
    expect([...picker.options].some((o) => (o.textContent ?? '').includes('Продукты'))).toBe(true)
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

describe('Settings: accounts', () => {
  it('account management is shown in multi mode only', async () => {
    await seed('single')
    const view = renderSettings()
    await screen.findByRole('region', { name: 'Сверка' })
    expect(screen.queryByRole('region', { name: 'Управление счетами' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Изменить счёт Основной' })).toBeNull()

    view.unmount()
    await env.repo.put<SettingsRow>('settings', { id: (await settingsRow()).id, accounts_mode: 'multi' })
    renderSettings()
    expect(await screen.findByRole('region', { name: 'Управление счетами' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Изменить счёт Основной' })).toBeTruthy()
  })

  it('renames an account and stores its aliases', async () => {
    await seed('multi')
    renderSettings()

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
    renderSettings()

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
    renderSettings()

    const btn = (await screen.findByRole('button', { name: 'Архивировать счёт Наличные' })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect((await env.db.accounts.get(cash.id))!.archived).toBe(false)
  })
})

describe('Settings: export and sign-out', () => {
  it('«Экспорт CSV» downloads seafarer-budget-YYYY-MM-DD.csv with the CSV text', async () => {
    await seed()
    await spend(12.5)
    const created: Blob[] = []
    const createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:fake'))
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download}|${this.href}`)
    })
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Экспорт CSV' }))

    await waitFor(() => expect(downloads).toEqual(['seafarer-budget-2026-10-21.csv|blob:fake']))
    expect(created[0].type).toContain('text/csv')
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(created[0])
    })
    expect(text).toContain('Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка')
    expect(text).toContain('Расход;12,5;UAH;')
    expect(text).toContain('Корректировка;5000;UAH;')
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake'))
    expect(document.querySelector('a[download]')).toBeNull() // the temporary link is removed
  })

  it('a failing export shows «Не удалось сохранить»', async () => {
    await seed()
    Object.assign(URL, { createObjectURL: () => { throw new Error('boom') }, revokeObjectURL: vi.fn() })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Экспорт CSV' }))
    expect(await screen.findByText('Не удалось сохранить')).toBeTruthy()
  })

  it('«Выйти» calls onSignOut', async () => {
    await seed()
    const onSignOut = vi.fn()
    renderSettings(onSignOut)
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('shows a hint instead of the form before the first-run setup', async () => {
    renderSettings()
    expect(await screen.findByText('Сначала завершите настройку')).toBeTruthy()
  })
})
