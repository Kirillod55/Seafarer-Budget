import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, FxRate } from '@shared/types.ts'
import { Accounts } from './Accounts.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let main: Account
let cash: Account

async function seed(mode: 'single' | 'multi' = 'multi') {
  await env.repo.initDefaults(mode, [{ currency: 'UAH', amount: 5000 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 41.2)])
  main = (await env.db.accounts.toCollection().first())!
  if (mode === 'multi') {
    cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
  }
}

const region = (name: string) => within(screen.getByRole('region', { name }))

beforeEach(() => {
  env = makeEnv()
})

describe('Accounts', () => {
  it('multi mode lists non-archived accounts with per-currency balances and the USD total', async () => {
    await seed()
    await env.repo.put<Account>('accounts', { name: 'Старый', aliases: [], is_default: false, archived: true, sort: 2 })
    renderWithApp(<Accounts />, env)

    expect(await screen.findByRole('region', { name: 'Основной' })).toBeTruthy()
    const card = region('Основной')
    expect(card.getByText('5 000 ₴')).toBeTruthy()
    expect(card.getByText('≈ $121.36')).toBeTruthy() // 5000 / 41.2
    expect(screen.getByRole('region', { name: 'Наличные' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Старый' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Перевод' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Обмен валюты' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ Счёт' })).toBeTruthy()
  })

  it('transfer 1000 ₴ from «Основной» to «Наличные» creates a transfer and moves the balances', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Перевод' }))
    fireEvent.change(await screen.findByLabelText('Со счёта'), { target: { value: main.id } })
    fireEvent.change(screen.getByLabelText('На счёт'), { target: { value: cash.id } })
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '1000' } })
    expect((screen.getByLabelText('Валюта') as HTMLSelectElement).value).toBe('UAH')
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }))

    await waitFor(() => expect(region('Наличные').getByText('1 000 ₴')).toBeTruthy())
    expect(region('Основной').getByText('4 000 ₴')).toBeTruthy()
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
      rate_usd: 1 / 41.2,
      amount_usd: 24.27,
      dirty: 1,
    })
    expect(screen.getByRole('button', { name: 'Перевод' })).toBeTruthy() // form closed
  })

  it('transfer between the same account is rejected with «Выберите разные счета»', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Перевод' }))
    fireEvent.change(await screen.findByLabelText('Со счёта'), { target: { value: main.id } })
    fireEvent.change(screen.getByLabelText('На счёт'), { target: { value: main.id } })
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Перевести' }))

    expect(await screen.findByText('Выберите разные счета')).toBeTruthy()
    expect(await env.db.transactions.filter((t) => t.kind === 'transfer').count()).toBe(0)
  })

  it('transfer with an empty amount is rejected with «Введите сумму»', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Перевод' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Перевести' }))

    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await env.db.transactions.filter((t) => t.kind === 'transfer').count()).toBe(0)
  })

  it('exchange 4120 ₴ -> $100 creates an exchange on the account and updates both currency balances', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Обмен валюты' }))
    fireEvent.change(await screen.findByLabelText('Счёт'), { target: { value: main.id } })
    fireEvent.change(screen.getByLabelText('Сумма списания'), { target: { value: '4120' } })
    fireEvent.change(screen.getByLabelText('Валюта списания'), { target: { value: 'UAH' } })
    fireEvent.change(screen.getByLabelText('Сумма зачисления'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Валюта зачисления'), { target: { value: 'USD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))

    await waitFor(() => expect(region('Основной').getByText('$100')).toBeTruthy())
    expect(region('Основной').getByText('880 ₴')).toBeTruthy()
    const exchanges = await env.db.transactions.filter((t) => t.kind === 'exchange').toArray()
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]).toMatchObject({
      amount: 4120,
      currency: 'UAH',
      to_amount: 100,
      to_currency: 'USD',
      account_id: main.id,
      to_account_id: main.id,
      category_id: null,
      date: TEST_TODAY,
      source: 'app',
      dirty: 1,
    })
  })

  it('exchange needs two different currencies and positive amounts', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Обмен валюты' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Обменять' }))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Сумма списания'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Сумма зачисления'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Валюта списания'), { target: { value: 'USD' } })
    fireEvent.change(screen.getByLabelText('Валюта зачисления'), { target: { value: 'USD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))
    expect(await screen.findByText('Выберите разные валюты')).toBeTruthy()
    expect(await env.db.transactions.filter((t) => t.kind === 'exchange').count()).toBe(0)
  })

  it('single mode: only «Обмен валюты» in the default account, plus the hint about several accounts', async () => {
    await seed('single')
    renderWithApp(<Accounts />, env)

    expect(await screen.findByText('Несколько счетов включаются в настройках')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Перевод' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Счёт' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Обмен валюты' }))
    expect(screen.queryByLabelText('Счёт')).toBeNull() // no account choice in single mode
    fireEvent.change(await screen.findByLabelText('Сумма списания'), { target: { value: '4120' } })
    fireEvent.change(screen.getByLabelText('Валюта списания'), { target: { value: 'UAH' } })
    fireEvent.change(screen.getByLabelText('Сумма зачисления'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Валюта зачисления'), { target: { value: 'USD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Обменять' }))

    await waitFor(async () => expect(await env.db.transactions.filter((t) => t.kind === 'exchange').count()).toBe(1))
    expect((await env.db.transactions.filter((t) => t.kind === 'exchange').first())!).toMatchObject({
      account_id: main.id,
      to_account_id: main.id,
      amount: 4120,
      to_amount: 100,
      to_currency: 'USD',
    })
  })

  it('«+ Счёт» adds an account with comma-separated aliases', async () => {
    await seed()
    renderWithApp(<Accounts />, env)

    fireEvent.click(await screen.findByRole('button', { name: '+ Счёт' }))
    fireEvent.change(await screen.findByLabelText('Название'), { target: { value: 'Карта' } })
    fireEvent.change(screen.getByLabelText('Псевдонимы (через запятую)'), { target: { value: 'карта, visa ,' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByRole('region', { name: 'Карта' })).toBeTruthy()
    const added = (await env.db.accounts.toArray()).find((a) => a.name === 'Карта')!
    expect(added).toMatchObject({ aliases: ['карта', 'visa'], is_default: false, archived: false, sort: 2, deleted: false, dirty: 1 })
  })

  it('«+ Счёт» needs a name', async () => {
    await seed()
    renderWithApp(<Accounts />, env)
    fireEvent.click(await screen.findByRole('button', { name: '+ Счёт' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Введите название')).toBeTruthy()
    expect(await env.db.accounts.count()).toBe(2)
  })
})
