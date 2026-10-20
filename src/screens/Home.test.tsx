import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from './Home.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'
import type { Settings } from '@shared/types.ts'

// "Example" settings: contract ends payout 2026-11-20 + 30 days lag = 2026-12-20, i.e. 60 days from 2026-10-21.
// Free money $3 040 -> $50.67 per day (~$51) -> $1 540.27 per 30.4 days (~$1 540).
let env: AppContextValue

async function seed(patch: Partial<Settings> = {}, openingUsd = 3040) {
  await env.repo.initDefaults('single', [{ currency: 'USD', amount: openingUsd }])
  const s = (await env.db.settings.toCollection().first())!
  await env.repo.put<Settings>('settings', { ...s, ...patch })
}

beforeEach(() => {
  env = makeEnv()
})

describe('Home', () => {
  it('shows the allowance per month and per day', async () => {
    await seed({ next_contract_date: '2026-11-20' })
    renderWithApp(<Home />, env)

    expect(await screen.findByText('$1 540 в месяц')).toBeTruthy()
    expect(screen.getByText('$51 в день')).toBeTruthy()
  })

  it('without a contract date: «Указать дату контракта» lets you save one', async () => {
    await seed({ next_contract_date: null })
    renderWithApp(<Home />, env)

    const btn = await screen.findByRole('button', { name: 'Указать дату контракта' })
    fireEvent.click(btn)
    fireEvent.change(screen.getByLabelText('Дата следующего контракта'), { target: { value: '2026-11-20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(async () => {
      expect((await env.db.settings.toCollection().first())!.next_contract_date).toBe('2026-11-20')
    })
    expect(await screen.findByText('$1 540 в месяц')).toBeTruthy()
  })

  it('in contract status shows «Заработано за контракт» and «Отложено в этом месяце» instead', async () => {
    await seed({ status: 'contract', contract_start_date: '2026-10-01', contract_end_date: '2027-03-31' }, 100)
    const account = (await env.db.accounts.toCollection().first())!
    await env.repo.addTransaction({
      kind: 'income',
      amount: 2000,
      currency: 'USD',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-10',
      note: 'зп',
      source: 'app',
    })
    await env.repo.addTransaction({
      kind: 'expense',
      amount: 500,
      currency: 'USD',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-12',
      note: 'расход',
      source: 'app',
    })
    renderWithApp(<Home />, env)

    expect(await screen.findByText('Заработано за контракт')).toBeTruthy()
    expect(screen.getByText('Отложено в этом месяце')).toBeTruthy()
    expect(screen.getByText('$2 000')).toBeTruthy() // earned
    expect(screen.getByText('$1 500')).toBeTruthy() // saved this month = 2000 - 500
    expect(screen.queryByText(/в месяц$/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Указать дату контракта' })).toBeNull()
  })

  it('shows negative free money plainly in red', async () => {
    await seed({ next_contract_date: '2026-11-20' }, -3040)
    renderWithApp(<Home />, env)

    const perDay = await screen.findByText('-$51 в день')
    expect(perDay.className).toContain('neg')
    expect(screen.getByText('-$1 540 в месяц')).toBeTruthy()
  })

  it('lists recent transactions with category and amount', async () => {
    await seed({ next_contract_date: '2026-11-20' })
    const account = (await env.db.accounts.toCollection().first())!
    const cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
    await env.repo.addTransaction({
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: cafe.id,
      date: '2026-10-21',
      note: 'кофе',
      source: 'app',
    })
    renderWithApp(<Home />, env)

    expect(await screen.findByText('кофе')).toBeTruthy()
    expect(screen.getByText('-80 ₴')).toBeTruthy()
    expect(screen.getByText(/Кафе и рестораны/)).toBeTruthy()
  })

  it('«+ Запись» opens an empty record and tapping a row opens that transaction', async () => {
    await seed({ next_contract_date: '2026-11-20' })
    const account = (await env.db.accounts.toCollection().first())!
    const tx = await env.repo.addTransaction({
      kind: 'expense',
      amount: 80,
      currency: 'UAH',
      account_id: account.id,
      to_account_id: null,
      to_amount: null,
      to_currency: null,
      category_id: null,
      date: '2026-10-21',
      note: 'кофе',
      source: 'app',
    })
    const onOpenRecord = vi.fn()
    renderWithApp(<Home onOpenRecord={onOpenRecord} />, env)

    fireEvent.click(await screen.findByRole('button', { name: '+ Запись' }))
    expect(onOpenRecord).toHaveBeenLastCalledWith(undefined)

    fireEvent.click(await screen.findByRole('button', { name: /кофе/ }))
    expect(onOpenRecord).toHaveBeenLastCalledWith(tx.id)
  })
})
