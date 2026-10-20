import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FxRate, Goal, GoalMove } from '@shared/types.ts'
import { Goals } from './Goals.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue

async function seed(withRates = true) {
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 10000 }])
  if (withRates) await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
}

const newGoal = (over: Partial<Goal> = {}) =>
  env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 15000, deadline: null, archived: false, ...over })

async function move(button: 'Отложить' | 'Забрать', amount: string, currency?: string) {
  fireEvent.click(await screen.findByRole('button', { name: button }))
  fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: amount } })
  if (currency) fireEvent.change(screen.getByLabelText('Валюта'), { target: { value: currency } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
}

beforeEach(() => {
  env = makeEnv()
})

describe('Goals', () => {
  it('«+ Цель» creates a goal «Машина» with target $15 000 and shows it with an empty progress', async () => {
    await seed()
    renderWithApp(<Goals />, env)

    fireEvent.click(await screen.findByRole('button', { name: '+ Цель' }))
    fireEvent.change(await screen.findByLabelText('Название'), { target: { value: 'Машина' } })
    fireEvent.change(screen.getByLabelText('Цель, $'), { target: { value: '15000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Машина')).toBeTruthy()
    expect(screen.getByText('$0 из $15 000')).toBeTruthy()
    expect(screen.getByText('темп пока не определён')).toBeTruthy()
    expect(await env.db.goals.toArray()).toMatchObject([
      { name: 'Машина', target_usd: 15000, deadline: null, archived: false, deleted: false, dirty: 1 },
    ])
  })

  it('a goal needs a name and a positive target', async () => {
    await seed()
    renderWithApp(<Goals />, env)
    fireEvent.click(await screen.findByRole('button', { name: '+ Цель' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Введите название')).toBeTruthy()
    expect(screen.getByText('Введите сумму')).toBeTruthy()
    expect(await env.db.goals.count()).toBe(0)
  })

  it('«Отложить» 500 ₴ stores a GoalMove in USD at the day rate and updates the progress', async () => {
    await seed()
    const goal = await newGoal()
    renderWithApp(<Goals />, env)

    await move('Отложить', '500')

    expect(await screen.findByText('$12.50 из $15 000')).toBeTruthy()
    const moves = await env.db.goal_moves.toArray()
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ goal_id: goal.id, amount_usd: 12.5, date: TEST_TODAY, deleted: false, dirty: 1 })
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0.1')
  })

  it('«Забрать» creates a negative GoalMove', async () => {
    await seed()
    const goal = await newGoal()
    await env.repo.put<GoalMove>('goal_moves', { goal_id: goal.id, amount_usd: 50, date: TEST_TODAY, note: '' })
    renderWithApp(<Goals />, env)
    expect(await screen.findByText('$50 из $15 000')).toBeTruthy()

    await move('Забрать', '200')

    expect(await screen.findByText('$45 из $15 000')).toBeTruthy()
    const moves = await env.db.goal_moves.filter((m) => m.amount_usd < 0).toArray()
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ goal_id: goal.id, amount_usd: -5, date: TEST_TODAY, dirty: 1 })
  })

  it('a currency without a known rate shows «Нет курса для этой валюты» and saves nothing', async () => {
    await seed()
    await newGoal()
    renderWithApp(<Goals />, env)

    await move('Отложить', '10', 'EUR')

    expect(await screen.findByText('Нет курса для этой валюты')).toBeTruthy()
    expect(await env.db.goal_moves.count()).toBe(0)
  })

  it('USD works even when no rates are known at all', async () => {
    await seed(false)
    await newGoal()
    renderWithApp(<Goals />, env)

    await move('Отложить', '50', 'USD')

    expect(await screen.findByText('$50 из $15 000')).toBeTruthy()
    expect(await env.db.goal_moves.toArray()).toMatchObject([{ amount_usd: 50 }])
  })

  it('an empty or zero amount is rejected with «Введите сумму»', async () => {
    await seed()
    await newGoal()
    renderWithApp(<Goals />, env)

    await move('Отложить', '0')

    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await env.db.goal_moves.count()).toBe(0)
  })

  it('shows the monthly amount needed for a goal with a deadline, and the ETA once there is a pace', async () => {
    await seed()
    const goal = await newGoal({ name: 'Отпуск', target_usd: 1000, deadline: '2027-10-21' })
    await env.repo.put<GoalMove>('goal_moves', { goal_id: goal.id, amount_usd: 90, date: TEST_TODAY, note: '' })
    renderWithApp(<Goals />, env)

    // remaining 910 over 365 days -> 910 / (365 / 30.4) = 75.79 per month
    expect(await screen.findByText('нужно откладывать $75.79 в месяц')).toBeTruthy()
    expect(screen.getByText(/наберётся к \d{2}\.\d{2}\.\d{4}/)).toBeTruthy()
  })

  it('«В архив» hides the goal and keeps the row', async () => {
    await seed()
    const goal = await newGoal()
    await newGoal({ name: 'Старая', archived: true })
    renderWithApp(<Goals />, env)
    expect(screen.queryByText('Старая')).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'В архив' }))

    await waitFor(() => expect(screen.queryByText('Машина')).toBeNull())
    expect(await env.db.goals.get(goal.id)).toMatchObject({ archived: true, deleted: false, dirty: 1 })
  })
})
