import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { reservedUsd, reservingGoalMoves } from '@shared/calc.ts'
import type { FxRate, Goal, GoalMove } from '@shared/types.ts'
import { Goals, untilMonth } from './Goals.tsx'
import { Navigator, type Route } from '../nav/Navigator.tsx'
import { ToastHost } from '../ui/Toast.tsx'
import { TEST_NOW, TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue

async function seed(withRates = true) {
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 10000 }])
  if (withRates) await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
}

const newGoal = (over: Partial<Goal> = {}) =>
  env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 15000, deadline: null, archived: false, ...over })

const addMove = (goal_id: string, amount_usd: number, date = TEST_TODAY) =>
  env.repo.put<GoalMove>('goal_moves', {
    goal_id,
    amount_usd,
    date,
    note: '',
    author: 'owner',
    source: 'app',
    created_at: TEST_NOW.toISOString(),
  })

/** Goals inside the navigator (its NavBar needs one); the archive route renders a marker. */
function renderGoals() {
  return renderWithApp(
    <>
      <Navigator
        renderScreen={(r: Route) => (r.screen === 'archive' ? <p>Экран архива</p> : <Goals />)}
      />
      <ToastHost />
    </>,
    env,
  )
}

async function move(button: 'Отложить' | 'Забрать', amount: string, currency?: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Отложить или забрать' }))
  fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: amount } })
  if (currency) {
    fireEvent.click(screen.getByLabelText('Валюта'))
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(currency) }))
  }
  fireEvent.click(screen.getByRole('button', { name: button }))
}

beforeEach(() => {
  env = makeEnv()
})

describe('untilMonth', () => {
  it('names the month in the dative: «июлю 2035»', () => {
    expect(untilMonth('2035-07-14')).toBe('июлю 2035')
    expect(untilMonth('2029-01-01')).toBe('январю 2029')
    expect(untilMonth('2027-05-31')).toBe('маю 2027')
  })
})

describe('Goals', () => {
  it('«Добавить» opens «Новая цель»; «Создать» saves «Машина» for $15 000 and shows it with an empty bar', async () => {
    await seed()
    renderGoals()

    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    expect(await screen.findByText('Новая цель')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Машина' } })
    fireEvent.change(screen.getByLabelText('Цель, $'), { target: { value: '15000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))

    expect(await screen.findByRole('heading', { name: 'Машина' })).toBeTruthy()
    expect(screen.queryByText('Новая цель')).toBeNull()
    expect(screen.getByText('$0')).toBeTruthy()
    expect(screen.getByText('из $15,000')).toBeTruthy()
    expect(screen.getByText('Темп пока не определён')).toBeTruthy()
    expect(screen.getByText('0%')).toBeTruthy()
    expect(await env.db.goals.toArray()).toMatchObject([
      { name: 'Машина', target_usd: 15000, deadline: null, archived: false, deleted: false, dirty: 1 },
    ])
  })

  it('a goal needs a name and a positive target; «Отмена» closes the form', async () => {
    await seed()
    renderGoals()
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Введите название')).toBeTruthy()
    expect(screen.getByText('Введите сумму')).toBeTruthy()
    expect(await env.db.goals.count()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByText('Новая цель')).toBeNull())
  })

  it('shows «Целей пока нет» without goals', async () => {
    await seed()
    renderGoals()
    expect(await screen.findByText('Целей пока нет')).toBeTruthy()
  })

  it('the action row: «Отложить или забрать» and «В архив» side by side', async () => {
    await seed()
    await newGoal()
    renderGoals()
    const put = await screen.findByRole('button', { name: 'Отложить или забрать' })
    const arch = screen.getByRole('button', { name: 'В архив' })
    expect(put.className).toContain('btn-gray')
    expect(arch.className).toContain('btn-tint')
    expect(put.parentElement).toBe(arch.parentElement)
    expect(put.parentElement!.className).toContain('goalacts')
  })

  it('«Отложить» 500 ₴ stores a move in USD at the day rate, by the owner from the app, with created_at', async () => {
    await seed()
    const goal = await newGoal()
    renderGoals()

    await move('Отложить', '500')

    await waitFor(() => expect(screen.queryByLabelText('Сумма')).toBeNull())
    // the live query catches up a moment after the form closes
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0.1'))
    const moves = await env.db.goal_moves.toArray()
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({
      goal_id: goal.id,
      amount_usd: 12.5,
      date: TEST_TODAY,
      note: '',
      author: 'owner',
      source: 'app',
      created_at: TEST_NOW.toISOString(),
      deleted: false,
      dirty: 1,
    })
  })

  it('«Забрать» creates a negative move', async () => {
    await seed()
    const goal = await newGoal({ target_usd: 100 })
    await addMove(goal.id, 50)
    renderGoals()
    expect(await screen.findByText('$50')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()

    await move('Забрать', '200')

    expect(await screen.findByText('$45')).toBeTruthy()
    const moves = await env.db.goal_moves.filter((m) => m.amount_usd < 0).toArray()
    expect(moves).toMatchObject([{ goal_id: goal.id, amount_usd: -5, author: 'owner', source: 'app' }])
  })

  it('«Забрать» never takes more than the goal holds: it stops at 0', async () => {
    await seed()
    const goal = await newGoal({ target_usd: 100 })
    await addMove(goal.id, 50)
    renderGoals()
    expect(await screen.findByText('$50')).toBeTruthy()

    await move('Забрать', '4000') // $100 asked, $50 saved

    expect(await screen.findByText('$0')).toBeTruthy()
    const taken = await env.db.goal_moves.filter((m) => m.amount_usd < 0).toArray()
    expect(taken).toMatchObject([{ goal_id: goal.id, amount_usd: -50 }])
  })

  it('«Забрать» from an empty goal saves nothing and says so', async () => {
    await seed()
    await newGoal()
    renderGoals()

    await move('Забрать', '100')

    expect(await screen.findByText('На цели пока ничего нет')).toBeTruthy()
    expect(await env.db.goal_moves.count()).toBe(0)
  })

  it('a currency without a known rate shows «Нет курса для этой валюты» and saves nothing', async () => {
    await seed()
    await newGoal()
    renderGoals()

    await move('Отложить', '10', 'EUR')

    expect(await screen.findByText('Нет курса для этой валюты')).toBeTruthy()
    expect(await env.db.goal_moves.count()).toBe(0)
  })

  it('USD works even when no rates are known at all', async () => {
    await seed(false)
    await newGoal()
    renderGoals()

    await move('Отложить', '50', 'USD')

    expect(await screen.findByText('$50')).toBeTruthy()
    expect(await env.db.goal_moves.toArray()).toMatchObject([{ amount_usd: 50 }])
  })

  it('an empty or zero amount is rejected with «Введите сумму»', async () => {
    await seed()
    await newGoal()
    renderGoals()

    await move('Отложить', '0')

    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(await env.db.goal_moves.count()).toBe(0)
  })

  it('«Нужно откладывать $X в месяц» for a deadline and «Наберётся к апрелю 2029» from the pace', async () => {
    await seed()
    const goal = await newGoal({ name: 'Отпуск', target_usd: 1000, deadline: '2027-10-21' })
    await addMove(goal.id, 90)
    renderGoals()

    // remaining 910 over 365 days -> 910 / (365 / 30.4) = 75.79 per month, whole dollars on screen
    expect(await screen.findByText('Нужно откладывать $76 в месяц')).toBeTruthy()
    // pace 90 / 90 days = $1 a day -> 910 days -> 2029-04-18
    expect(screen.getByText('Наберётся к апрелю 2029')).toBeTruthy()
  })

  it('a reached goal says «Цель достигнута» and asks for nothing more', async () => {
    await seed()
    const goal = await newGoal({ target_usd: 100, deadline: '2027-10-21' })
    await addMove(goal.id, 120)
    renderGoals()
    expect(await screen.findByText('Цель достигнута')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.queryByText(/Нужно откладывать/)).toBeNull()
  })

  it('an archived goal is not listed and reserves nothing', async () => {
    await seed()
    const live = await newGoal()
    const old = await newGoal({ name: 'Старая', archived: true })
    await addMove(live.id, 100)
    await addMove(old.id, 900)
    renderGoals()

    expect(await screen.findByRole('heading', { name: 'Машина' })).toBeTruthy()
    expect(screen.queryByText('Старая')).toBeNull()
    const goals = await env.db.goals.toArray()
    const moves = await env.db.goal_moves.toArray()
    expect(reservedUsd(reservingGoalMoves(moves, goals))).toBe(100)
  })

  it('«Архив целей · 1» shows with one archived goal and opens the archive', async () => {
    await seed()
    await newGoal()
    await newGoal({ name: 'Старая', archived: true })
    renderGoals()

    fireEvent.click(await screen.findByRole('button', { name: 'Архив целей · 1' }))
    expect(await screen.findByText('Экран архива')).toBeTruthy()
  })

  it('no archive link without archived goals', async () => {
    await seed()
    await newGoal()
    renderGoals()
    await screen.findByRole('heading', { name: 'Машина' })
    expect(screen.queryByRole('button', { name: /Архив целей/ })).toBeNull()
  })

  it('«В архив» hides the goal, keeps the row, counts it in the link, and «Отменить» brings it back', async () => {
    await seed()
    const goal = await newGoal()
    renderGoals()

    fireEvent.click(await screen.findByRole('button', { name: 'В архив' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Машина' })).toBeNull())
    expect(await env.db.goals.get(goal.id)).toMatchObject({ archived: true, deleted: false, dirty: 1 })
    expect(await screen.findByRole('button', { name: 'Архив целей · 1' })).toBeTruthy()
    expect(await screen.findByText('Цель в архиве')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByRole('heading', { name: 'Машина' })).toBeTruthy()
    expect(await env.db.goals.get(goal.id)).toMatchObject({ archived: false })
  })
})
