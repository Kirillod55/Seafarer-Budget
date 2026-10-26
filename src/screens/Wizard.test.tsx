import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Settings } from '@shared/types.ts'
import { Wizard } from './Wizard.tsx'
import { TEST_TODAY, makeEnv, renderWithApp, reducedMotion } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

let env: AppContextValue

/** Reduce Motion on: rows come and go at once. */
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const amount = (n: number) => screen.getByLabelText(n === 1 ? 'Сумма' : `Сумма ${n}`) as HTMLInputElement
const currencyOf = (n: number) =>
  screen.getByRole('button', { name: new RegExp(`^${n === 1 ? 'Валюта' : `Валюта ${n}`}: `) }).getAttribute('value')
const settingsRow = async () => (await env.db.settings.toCollection().first()) as Settings | undefined

beforeEach(() => {
  env = makeEnv()
  reducedMotion()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Мастер первого запуска', () => {
  it('«Один баланс» → 5000 ₴ → «Дальше» → «Пропустить»: initDefaults("single", [UAH 5000]), no landing date', async () => {
    const onDone = vi.fn()
    const init = vi.spyOn(env.repo, 'initDefaults')
    renderWithApp(<Wizard onDone={onDone} />, env)

    expect(screen.getByText('Шаг 1 из 3')).toBeTruthy()
    click('Один баланс')
    expect(await screen.findByText('Шаг 2 из 3')).toBeTruthy()
    expect(currencyOf(1)).toBe('UAH')
    fireEvent.change(amount(1), { target: { value: '5000' } })
    click('Дальше')
    expect(await screen.findByText('Шаг 3 из 3')).toBeTruthy()
    click('Пропустить')

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(init).toHaveBeenCalledWith('single', [{ currency: 'UAH', amount: 5000 }])
    expect(await settingsRow()).toMatchObject({ accounts_mode: 'single', next_contract_date: null, reserve_usd: 0 })
  })

  it('two currencies create two opening balances; the landing date and the reserve are saved', async () => {
    const onDone = vi.fn()
    renderWithApp(<Wizard onDone={onDone} />, env)

    click('Несколько счетов')
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '1 200,5' } })
    click('+ Ещё валюта')
    expect(currencyOf(2)).toBe('USD')
    fireEvent.change(amount(2), { target: { value: '300' } })
    click('Дальше')
    fireEvent.change(await screen.findByLabelText('Дата посадки'), { target: { value: '2026-12-20' } })
    fireEvent.change(screen.getByLabelText('Запас, $'), { target: { value: '1000' } })
    click('Готово')

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const accounts = (await env.db.accounts.toArray()) as Account[]
    expect(accounts).toMatchObject([{ name: 'Основной', is_default: true }])
    const opening = await env.db.transactions.filter((t) => t.note === 'Начальный остаток').toArray()
    expect(opening.map((t) => [t.currency, t.amount]).sort()).toEqual([
      ['UAH', 1200.5],
      ['USD', 300],
    ])
    for (const t of opening) expect(t).toMatchObject({ kind: 'adjustment', account_id: accounts[0].id, date: '2026-10-20', author: 'owner' })
    expect(await settingsRow()).toMatchObject({ accounts_mode: 'multi', next_contract_date: '2026-12-20', reserve_usd: 1000 })
  })

  it('«+ Ещё валюта» takes the first currency not chosen yet; «×» removes a row; at most 5', async () => {
    renderWithApp(<Wizard onDone={vi.fn()} />, env)
    click('Один баланс')
    await screen.findByText('Шаг 2 из 3')

    click('+ Ещё валюта') // UAH taken → USD
    expect(currencyOf(2)).toBe('USD')
    expect(document.activeElement).toBe(amount(2)) // the cursor goes to the new sum
    click('+ Ещё валюта') // → EUR
    expect(currencyOf(3)).toBe('EUR')
    click('Убрать валюту 2') // USD goes
    await waitFor(() => expect(screen.queryByLabelText('Сумма 3')).toBeNull())
    expect(currencyOf(2)).toBe('EUR')
    click('+ Ещё валюта') // USD is free again
    expect(currencyOf(3)).toBe('USD')
    click('+ Ещё валюта')
    click('+ Ещё валюта')
    expect(currencyOf(5)).toBe('PLN')
    expect(screen.queryByRole('button', { name: '+ Ещё валюта' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Убрать валюту 1' })).toBeNull() // the first row stays
  })

  it('a currency from the menu ends up in the settings list', async () => {
    renderWithApp(<Wizard onDone={vi.fn()} />, env)
    click('Один баланс')
    await screen.findByText('Шаг 2 из 3')
    fireEvent.click(screen.getByLabelText('Валюта'))
    fireEvent.click(await screen.findByRole('option', { name: /PLN/ }))
    fireEvent.change(amount(1), { target: { value: '50' } })
    click('Дальше')
    click('Пропустить')

    await waitFor(async () => expect((await settingsRow())?.currencies).toContain('PLN'))
    expect(await env.db.transactions.filter((t) => t.currency === 'PLN' && t.amount === 50).count()).toBe(1)
  })

  it('a sum that is not a number is refused; «Назад» goes to the step before', async () => {
    renderWithApp(<Wizard onDone={vi.fn()} />, env)
    click('Один баланс')
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: 'много' } })
    click('Дальше')
    expect(await screen.findByText('Введите сумму числом, например 5000')).toBeTruthy()
    expect(screen.getByText('Шаг 2 из 3')).toBeTruthy()

    click('Назад')
    expect(await screen.findByText('Шаг 1 из 3')).toBeTruthy()
  })

  it('the live line on the landing step: «= $X в день на N дней»', async () => {
    await env.db.fx_rates.bulkPut([
      { date: TEST_TODAY, currency: 'USD', uah_per_unit: 40 },
      { date: TEST_TODAY, currency: 'UAH', uah_per_unit: 1 },
    ])
    renderWithApp(<Wizard onDone={vi.fn()} />, env)
    click('Один баланс')
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '1000' } })
    click('+ Ещё валюта')
    fireEvent.change(amount(2), { target: { value: '575' } }) // $25 + $575 = $600
    click('Дальше')
    fireEvent.change(await screen.findByLabelText('Дата посадки'), { target: { value: '2026-10-30' } }) // 10 days with today
    fireEvent.change(screen.getByLabelText('Запас, $'), { target: { value: '100' } })

    expect(screen.getByText(/в день на/).textContent).toBe('= $50 в день на 10 дней, к посадке останется $100')
  })
})

describe('Мастер с шага «Остаток» (после «Удалить все данные»)', () => {
  it('writes only opening balances: no initDefaults, settings and accounts kept', async () => {
    await env.repo.initDefaults('multi', [{ currency: 'UAH', amount: 0, accountName: 'Карта' }])
    const s = (await settingsRow())!
    await env.repo.put<Settings>('settings', { id: s.id, next_contract_date: '2026-12-20', reserve_usd: 700 })
    const settingsBefore = await env.db.settings.toArray()
    const init = vi.spyOn(env.repo, 'initDefaults')
    const onDone = vi.fn()
    renderWithApp(<Wizard onDone={onDone} startAt="balance" />, env)

    expect(screen.queryByText(/Шаг/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Один баланс' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '900' } })
    click('+ Ещё валюта')
    fireEvent.change(amount(2), { target: { value: '20' } })
    click('Готово')

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(init).not.toHaveBeenCalled()
    expect(await env.db.settings.toArray()).toEqual(settingsBefore)
    const accounts = await env.db.accounts.toArray()
    expect(accounts.map((a) => a.name)).toEqual(['Карта'])
    const opening = await env.db.transactions.filter((t) => t.note === 'Начальный остаток').toArray()
    expect(opening.map((t) => [t.currency, t.amount, t.account_id]).sort()).toEqual([
      ['UAH', 900, accounts[0].id],
      ['USD', 20, accounts[0].id],
    ])
  })
})
