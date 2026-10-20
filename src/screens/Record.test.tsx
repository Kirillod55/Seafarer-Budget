import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, FxRate, Settings, Transaction } from '@shared/types.ts'
import { RecordScreen } from './Record.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let existing: Transaction

async function seed(mode: 'single' | 'multi' = 'single') {
  await env.repo.initDefaults(mode, [{ currency: 'USD', amount: 100 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
  const account = (await env.db.accounts.toCollection().first())!
  const cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
  existing = await env.repo.addTransaction({
    kind: 'expense',
    amount: 80,
    currency: 'UAH',
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cafe.id,
    date: TEST_TODAY,
    note: 'кофе',
    source: 'app',
  })
}

beforeEach(() => {
  env = makeEnv()
})

describe('Record', () => {
  it('opens an existing expense, changing 80 -> 120 saves with recomputed amount_usd and dirty:1', async () => {
    await seed()
    expect(existing.amount_usd).toBe(2)
    await env.db.transactions.update(existing.id, { dirty: 0 })
    const onDone = vi.fn()
    renderWithApp(<RecordScreen id={existing.id} onDone={onDone} />, env)

    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('80'))
    expect((screen.getByLabelText('Заметка') as HTMLInputElement).value).toBe('кофе')
    expect((screen.getByLabelText('Валюта') as HTMLSelectElement).value).toBe('UAH')
    expect((screen.getByLabelText('Категория') as HTMLSelectElement).selectedOptions[0].textContent).toContain('Кафе и рестораны')

    fireEvent.change(amount, { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(await env.db.transactions.get(existing.id)).toMatchObject({
      amount: 120,
      amount_usd: 3,
      rate_pending: false,
      dirty: 1,
      deleted: false,
      note: 'кофе',
      category_id: existing.category_id,
    })
    expect(await env.db.transactions.count()).toBe(2) // the opening adjustment + the edited expense, no duplicate
  })

  it('«Удалить» calls repo.remove and soft-deletes the transaction', async () => {
    await seed()
    const remove = vi.spyOn(env.repo, 'remove')
    const onDone = vi.fn()
    renderWithApp(<RecordScreen id={existing.id} onDone={onDone} />, env)

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('transactions', existing.id))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(await env.db.transactions.get(existing.id)).toMatchObject({ deleted: true, dirty: 1 })
  })

  it('«Счёт» is hidden in single mode and shown in multi mode (non-archived accounts only)', async () => {
    await seed('single')
    const first = renderWithApp(<RecordScreen id={existing.id} onDone={() => {}} />, env)
    await screen.findByLabelText('Сумма')
    expect(screen.queryByLabelText('Счёт')).toBeNull()
    first.unmount()

    const s = (await env.db.settings.toCollection().first())!
    await env.repo.put<Settings>('settings', { ...s, accounts_mode: 'multi' })
    await env.repo.put<Account>('accounts', { name: 'Карта', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.put<Account>('accounts', { name: 'Старый', aliases: [], is_default: false, archived: true, sort: 2 })
    renderWithApp(<RecordScreen id={existing.id} onDone={() => {}} />, env)

    const account = (await screen.findByLabelText('Счёт')) as HTMLSelectElement
    expect([...account.options].map((o) => o.textContent)).toEqual(['Основной', 'Карта'])
  })

  it('a new record: empty amount is rejected with «Введите сумму»', async () => {
    await seed()
    const addTransaction = vi.spyOn(env.repo, 'addTransaction')
    renderWithApp(<RecordScreen onDone={() => {}} />, env)

    await screen.findByLabelText('Сумма')
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(addTransaction).not.toHaveBeenCalled()
  })

  it('a new record defaults to an expense today in the default currency and is added via addTransaction', async () => {
    await seed()
    const addTransaction = vi.spyOn(env.repo, 'addTransaction')
    const onDone = vi.fn()
    renderWithApp(<RecordScreen onDone={onDone} />, env)

    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    expect((screen.getByLabelText('Валюта') as HTMLSelectElement).value).toBe('UAH')
    expect((screen.getByLabelText('Дата') as HTMLInputElement).value).toBe(TEST_TODAY)
    fireEvent.change(amount, { target: { value: '12,5' } })
    fireEvent.change(screen.getByLabelText('Валюта'), { target: { value: 'EUR' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(addTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'expense', amount: 12.5, currency: 'EUR', date: TEST_TODAY, source: 'app', category_id: null }),
    )
  })

  it('switching to «Доход» offers only income categories', async () => {
    await seed()
    renderWithApp(<RecordScreen onDone={() => {}} />, env)
    await screen.findByLabelText('Сумма')

    const names = () => [...(screen.getByLabelText('Категория') as HTMLSelectElement).options].map((o) => o.textContent ?? '')
    expect(names().some((n) => n.includes('Кафе и рестораны'))).toBe(true)
    expect(names().some((n) => n.includes('Зарплата'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Доход' }))
    expect(names().some((n) => n.includes('Зарплата'))).toBe(true)
    expect(names().some((n) => n.includes('Кафе и рестораны'))).toBe(false)
  })

  it('«Отмена» leaves without saving', async () => {
    await seed()
    const addTransaction = vi.spyOn(env.repo, 'addTransaction')
    const onDone = vi.fn()
    renderWithApp(<RecordScreen onDone={onDone} />, env)
    fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(addTransaction).not.toHaveBeenCalled()
  })

  it('a record whose category was deleted shows «Без категории» and saves category_id null', async () => {
    await seed()
    await env.repo.remove('categories', existing.category_id!)
    renderWithApp(<RecordScreen id={existing.id} onDone={() => {}} />, env)

    const select = (await screen.findByLabelText('Категория')) as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('Без категории')
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(async () => expect((await env.db.transactions.get(existing.id))!.dirty).toBe(1))
    expect((await env.db.transactions.get(existing.id))!.category_id).toBeNull()
  })

  it('an empty date is rejected with «Укажите дату»', async () => {
    await seed()
    const addTransaction = vi.spyOn(env.repo, 'addTransaction')
    renderWithApp(<RecordScreen onDone={() => {}} />, env)

    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Укажите дату')).toBeTruthy()
    expect(addTransaction).not.toHaveBeenCalled()
  })

  it('adjustment: a negative amount -50 -> -70 saves signed with recomputed amount_usd; currency and account are locked', async () => {
    await seed('multi')
    const account = (await env.db.accounts.toCollection().first())!
    const adj = await env.repo.addTransaction({
      kind: 'adjustment',
      amount: -50,
      currency: 'USD',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: TEST_TODAY,
      note: 'корректировка',
      source: 'app',
    })
    expect(adj.amount_usd).toBe(-50)
    await env.db.transactions.update(adj.id, { dirty: 0 })
    const onDone = vi.fn()
    renderWithApp(<RecordScreen id={adj.id} onDone={onDone} />, env)

    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    expect(amount.readOnly).toBe(false)
    expect((screen.getByLabelText('Валюта') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'Расход' })).toBeNull()

    fireEvent.change(amount, { target: { value: '-70' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(await env.db.transactions.get(adj.id)).toMatchObject({
      kind: 'adjustment',
      amount: -70,
      amount_usd: -70,
      currency: 'USD',
      account_id: account.id,
      dirty: 1,
    })
  })

  it('adjustment: a zero amount is rejected with «Введите сумму»', async () => {
    await seed()
    const account = (await env.db.accounts.toCollection().first())!
    const adj = await env.repo.addTransaction({
      kind: 'adjustment',
      amount: -50,
      currency: 'USD',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: TEST_TODAY,
      note: '',
      source: 'app',
    })
    renderWithApp(<RecordScreen id={adj.id} onDone={() => {}} />, env)
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect((await env.db.transactions.get(adj.id))!.amount).toBe(-50)
  })

  it('transfer: only date and note are editable; amount, currency, accounts and to_* stay unchanged', async () => {
    await seed('multi')
    const from = (await env.db.accounts.toCollection().first())!
    const to = await env.repo.put<Account>('accounts', { name: 'Карта', aliases: [], is_default: false, archived: false, sort: 1 })
    const transfer = await env.repo.addTransaction({
      kind: 'exchange',
      amount: 4000,
      currency: 'UAH',
      account_id: from.id,
      to_account_id: to.id,
      to_amount: 100,
      to_currency: 'USD',
      category_id: null,
      date: TEST_TODAY,
      note: 'обмен',
      source: 'app',
    })
    await env.db.transactions.update(transfer.id, { dirty: 0 })
    const onDone = vi.fn()
    renderWithApp(<RecordScreen id={transfer.id} onDone={onDone} />, env)

    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    expect(amount.readOnly).toBe(true)
    expect((screen.getByLabelText('Валюта') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт зачисления') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Получено') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByLabelText('Категория')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Расход' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Заметка'), { target: { value: 'обмен в банке' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(await env.db.transactions.get(transfer.id)).toMatchObject({
      kind: 'exchange',
      note: 'обмен в банке',
      amount: 4000,
      currency: 'UAH',
      account_id: from.id,
      to_account_id: to.id,
      to_amount: 100,
      to_currency: 'USD',
      dirty: 1,
    })
  })})
