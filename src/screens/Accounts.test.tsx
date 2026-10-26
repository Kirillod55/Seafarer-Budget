import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, FxRate, Goal, GoalMove } from '@shared/types.ts'
import { Accounts } from './Accounts.tsx'
import { TEST_NOW, TEST_TODAY, makeEnv, renderWithApp, reducedMotion } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'
import { Navigator } from '../nav/Navigator.tsx'
import { ToastHost } from '../ui/Toast.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let main: Account
let cash: Account

/** Reduce Motion on: blocks swap at once. */
async function seed(mode: 'single' | 'multi' = 'multi') {
  await env.repo.initDefaults(mode, [{ currency: 'UAH', amount: 5000 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 41.2)])
  main = (await env.db.accounts.toCollection().first())!
  if (mode === 'multi') {
    cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
  }
}

function renderAccounts() {
  return renderWithApp(
    <>
      <Navigator renderScreen={() => <Accounts />} />
      <ToastHost />
    </>,
    env,
  )
}

const card = (name: string) => within(screen.getByRole('region', { name }))
const ops = () => within(screen.getByRole('region', { name: 'Операции' }))
const kindCount = (kind: string) => env.db.transactions.filter((t) => t.kind === kind).count()

async function pick(field: string, option: string | RegExp) {
  fireEvent.click(screen.getByLabelText(field))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

beforeEach(() => {
  env = makeEnv()
  reducedMotion()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Счета: cards', () => {
  it('multi: a card per active account with ≈ $ and currency pills; «Основной» on the default; the summary tiles', async () => {
    await seed()
    await env.repo.put<Account>('accounts', { name: 'Старый', aliases: [], is_default: false, archived: true, sort: 2 })
    const goal = await env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 1000, deadline: null, archived: false })
    await env.repo.put<GoalMove>('goal_moves', {
      goal_id: goal.id,
      amount_usd: 20,
      date: TEST_TODAY,
      note: '',
      author: 'owner',
      source: 'app',
      created_at: TEST_NOW.toISOString(),
    })
    renderAccounts()

    expect(await screen.findByRole('region', { name: 'Основной' })).toBeTruthy()
    expect(card('Основной').getByText('₴5,000')).toBeTruthy()
    expect(card('Основной').getByText('≈ $121')).toBeTruthy() // 5000 / 41.2, whole dollars
    expect(card('Основной').getByText('Основной', { selector: '.acard-badge' })).toBeTruthy()
    expect(card('Наличные').getByText('Пусто')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Старый' })).toBeNull()

    const sum = within(screen.getByRole('group', { name: 'Сводка' }))
    expect(sum.getByText('Всего ≈')).toBeTruthy()
    expect(sum.getByText('$121')).toBeTruthy()
    expect(sum.getByText('$101')).toBeTruthy() // free: 121.36 − 20 in goals
    expect(sum.getByText('$20')).toBeTruthy()

    expect(screen.getByRole('button', { name: /Новый счёт/ })).toBeTruthy()
    expect(within(ops().getByRole('group', { name: 'Операция' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Перевод',
      'Обмен',
      'Сверка',
    ])
  })

  it('«В архив» is on the other accounts only; it hides the card, «Отменить» brings it back', async () => {
    await seed()
    renderAccounts()

    await screen.findByRole('region', { name: 'Наличные' })
    expect(card('Основной').queryByRole('button', { name: /в архив/ })).toBeNull()
    fireEvent.click(card('Наличные').getByRole('button', { name: 'Убрать «Наличные» в архив' }))

    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(true))
    expect(await screen.findByText('Счёт в архиве')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Наличные' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(false))
    expect(await screen.findByRole('region', { name: 'Наличные' })).toBeTruthy()
  })

  it('«＋ Счёт» adds an account with the bot aliases; a repeated name is refused', async () => {
    await seed()
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Новый счёт' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Введите название')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'наличные' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Такой счёт уже есть')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Карта' } })
    fireEvent.change(screen.getByLabelText('Псевдонимы для бота'), { target: { value: 'карта, visa ,' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))

    expect(await screen.findByRole('region', { name: 'Карта' })).toBeTruthy()
    const added = (await env.db.accounts.toArray()).find((a) => a.name === 'Карта')!
    expect(added).toMatchObject({ aliases: ['карта', 'visa'], is_default: false, archived: false, sort: 2, deleted: false, dirty: 1 })
  })

  it('the pencil on a card renames the account and edits its aliases (the bot finds it by them)', async () => {
    await seed()
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить «Основной»' }))
    const name = (await screen.findByLabelText('Название')) as HTMLInputElement
    expect(name.value).toBe('Основной')
    fireEvent.change(name, { target: { value: 'Моно' } })
    fireEvent.change(screen.getByLabelText('Псевдонимы для бота'), { target: { value: 'карта, mono , ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(async () =>
      expect(await env.db.accounts.get(main.id)).toMatchObject({ name: 'Моно', aliases: ['карта', 'mono'], dirty: 1 }),
    )
    expect(await screen.findByRole('region', { name: 'Моно' })).toBeTruthy()
  })

  it('single mode: one card «Один баланс», operations «Обмен · Сверка», the hint where to switch', async () => {
    await seed('single')
    renderAccounts()

    expect(await screen.findByRole('region', { name: 'Один баланс' })).toBeTruthy()
    expect(within(ops().getByRole('group', { name: 'Операция' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Обмен',
      'Сверка',
    ])
    expect(screen.queryByRole('button', { name: 'Новый счёт' })).toBeNull()
    expect(screen.getByText(/Сейчас режим «Один баланс»/)).toBeTruthy()
  })
})

describe('Счета: operations', () => {
  it('choosing in «Куда» the account that stands in «Откуда» swaps them', async () => {
    await seed()
    renderAccounts()

    await screen.findByRole('region', { name: 'Операции' })
    expect(screen.getByLabelText('Откуда').getAttribute('aria-label')).toBe('Откуда: Основной')
    expect(screen.getByLabelText('Куда').getAttribute('aria-label')).toBe('Куда: Наличные')
    await pick('Куда', /Основной/)

    await waitFor(() => expect(screen.getByLabelText('Куда').getAttribute('aria-label')).toBe('Куда: Основной'))
    expect(screen.getByLabelText('Откуда').getAttribute('aria-label')).toBe('Откуда: Наличные')
  })

  it('transfer 1000 ₴ from «Основной» to «Наличные» writes a transfer and moves the balances', async () => {
    await seed()
    renderAccounts()

    await screen.findByRole('region', { name: 'Операции' })
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '1000' } })
    expect(screen.getByLabelText('Валюта').getAttribute('aria-label')).toBe('Валюта: UAH')
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }))

    await waitFor(() => expect(card('Наличные').getByText('₴1,000')).toBeTruthy())
    expect(card('Основной').getByText('₴4,000')).toBeTruthy()
    const transfers = await env.db.transactions.filter((t) => t.kind === 'transfer').toArray()
    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({
      amount: 1000,
      currency: 'UAH',
      account_id: main.id,
      to_account_id: cash.id,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: TEST_TODAY,
      source: 'app',
      author: 'owner',
      archived: false,
      rate_usd: 1 / 41.2,
      amount_usd: 24.27,
      dirty: 1,
    })
    expect((screen.getByLabelText('Сумма') as HTMLInputElement).value).toBe('')
  })

  it('transfer with an empty amount is refused with «Введите сумму»', async () => {
    await seed()
    renderAccounts()
    fireEvent.click(await screen.findByRole('button', { name: 'Перевести' }))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await kindCount('transfer')).toBe(0)
  })

  it('with one active account the transfer is not offered: a hint says two are needed', async () => {
    await seed()
    await env.repo.put<Account>('accounts', { id: cash.id, archived: true })
    renderAccounts()

    expect(await within(await screen.findByRole('region', { name: 'Операции' })).findByText('Для перевода нужно хотя бы два счёта. Убранные счета — в «Архиве».')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull()
    expect(screen.queryByLabelText('Откуда')).toBeNull()
  })

  it('exchange 4120 ₴ → $100 on the account; the live rate line compares with the NBU', async () => {
    await seed()
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Обмен' }))
    expect(await screen.findByText('Курс появится, когда впишешь обе суммы')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Отдал'), { target: { value: '4120' } })
    fireEvent.change(screen.getByLabelText('Получил'), { target: { value: '100' } })
    expect(screen.getByRole('button', { name: 'Валюта, отдал: UAH' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Валюта, получил: USD' })).toBeTruthy()
    expect(screen.getByText(/1 USD = /).textContent).toBe('1 USD = 41.20 UAH · НБУ 41.20 · как у НБУ')
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))

    await waitFor(() => expect(card('Основной').getByText('$100')).toBeTruthy())
    expect(card('Основной').getByText('₴880')).toBeTruthy()
    expect((await env.db.transactions.filter((t) => t.kind === 'exchange').first())!).toMatchObject({
      amount: 4120,
      currency: 'UAH',
      to_amount: 100,
      to_currency: 'USD',
      account_id: main.id,
      to_account_id: main.id,
      date: TEST_TODAY,
      author: 'owner',
      archived: false,
    })
  })

  it('exchange needs positive amounts and two different currencies', async () => {
    await seed()
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Обмен' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Обменять' }))
    expect(await screen.findByText('Введите обе суммы')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Отдал'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Получил'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Валюта, получил: USD' }))
    fireEvent.click(await screen.findByRole('option', { name: /UAH/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))
    expect(await screen.findByText('Выберите разные валюты')).toBeTruthy()
    expect(await kindCount('exchange')).toBe(0)
  })

  it('«Сверка»: the real amount on an account → the difference as an adjustment', async () => {
    await seed()
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Сверка' }))
    expect((await screen.findByLabelText('Счёт')).getAttribute('aria-label')).toBe('Счёт: Наличные')
    await pick('Счёт', /Основной/)
    fireEvent.change(screen.getByLabelText('Сколько на самом деле'), { target: { value: '4800' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сверить' }))

    expect(await screen.findByText('Корректировка -₴200')).toBeTruthy()
    const adj = (await env.db.transactions.filter((t) => t.kind === 'adjustment' && t.note === 'Сверка').toArray())[0]
    expect(adj).toMatchObject({ amount: -200, currency: 'UAH', account_id: main.id, date: TEST_TODAY, author: 'owner' })
  })

  it('single mode «Обмен» goes to the default account without an account field', async () => {
    await seed('single')
    renderAccounts()

    expect(await screen.findByRole('region', { name: 'Операции' })).toBeTruthy()
    expect(screen.queryByLabelText('Счёт')).toBeNull()
    fireEvent.change(screen.getByLabelText('Отдал'), { target: { value: '4120' } })
    fireEvent.change(screen.getByLabelText('Получил'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))

    await waitFor(async () => expect(await kindCount('exchange')).toBe(1))
    expect((await env.db.transactions.filter((t) => t.kind === 'exchange').first())!).toMatchObject({
      account_id: main.id,
      to_account_id: main.id,
    })
  })

  it('no settings yet: asks to finish the setup', async () => {
    renderAccounts()
    expect(await screen.findByText('Сначала завершите настройку')).toBeTruthy()
  })
})
