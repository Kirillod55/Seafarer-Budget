import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { Calendar } from './Calendar.tsx'
import { RecordSheetHost } from './RecordSheet.tsx'
import { Navigator } from '../nav/Navigator.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'
import type { Settings, Transaction } from '@shared/types.ts'

// TEST_TODAY is Wednesday 2026-10-21.
let env: AppContextValue

type Tx = { kind: 'expense' | 'income'; amount: number; date: string; note?: string; archived?: boolean }

async function seed(patch: Partial<Settings>, txs: Tx[] = []) {
  await env.repo.initDefaults('single', [])
  const s = (await env.db.settings.toCollection().first())!
  await env.repo.put<Settings>('settings', { id: s.id, ...patch })
  const account = (await env.db.accounts.toCollection().first())!
  const out: Transaction[] = []
  for (const t of txs) {
    out.push(
      await env.repo.addTransaction({
        kind: t.kind,
        amount: t.amount,
        currency: 'USD',
        account_id: account.id,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: t.date,
        note: t.note ?? '',
        source: 'app',
        author: 'owner',
        archived: t.archived ?? false,
      }),
    )
  }
  return out
}

function renderCalendar() {
  return renderWithApp(
    <RecordSheetHost>
      <Navigator renderScreen={() => <Calendar />} />
    </RecordSheetHost>,
    env,
  )
}

const cell = (date: string) => document.querySelector(`.day[data-day="${date}"]`) as HTMLButtonElement
const dayCard = () => document.querySelector('.calday') as HTMLElement

beforeEach(() => {
  env = makeEnv()
})

describe('Calendar: the month grid', () => {
  it('cells show the day spending in whole dollars; empty days are blank; «за месяц» is the month total', async () => {
    await seed({}, [
      { kind: 'expense', amount: 12.4, date: '2026-10-05', note: 'кофе' },
      { kind: 'expense', amount: 7.7, date: '2026-10-05', note: 'булка' },
      { kind: 'income', amount: 500, date: '2026-10-05' },
      { kind: 'expense', amount: 36.68, date: '2026-10-21' },
      { kind: 'expense', amount: 99, date: '2026-09-30' },
    ])
    renderCalendar()
    await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    await waitFor(() => expect(cell('2026-10-05').querySelector('.dv')!.textContent).toBe('$20'))
    expect(cell('2026-10-21').querySelector('.dv')!.textContent).toBe('$37')
    expect(cell('2026-10-06').querySelector('.dv')!.textContent).toBe('')
    expect(cell('2026-10-05').getAttribute('aria-label')).toBe('5 октября, потрачено $20.10')
    expect(screen.getByText('За месяц $57')).toBeTruthy()
    // Monday-first: 1 October 2026 is a Thursday, three blanks before it
    const grid = document.querySelector('.cal')!
    expect([...grid.querySelectorAll('.wd')].map((w) => w.textContent)).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'])
    expect(grid.querySelectorAll('.cal-blank').length).toBe(3)
    expect(grid.querySelectorAll('.day').length).toBe(31)
  })

  it('future days are disabled; today is outlined and selected; the landing day carries ⚓', async () => {
    await seed({ next_contract_date: '2026-10-28' })
    renderCalendar()
    await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    await waitFor(() => expect(cell('2026-10-21')).toBeTruthy())
    expect(cell('2026-10-21').disabled).toBe(false)
    expect(cell('2026-10-22').disabled).toBe(true)
    expect(cell('2026-10-31').disabled).toBe(true)
    expect(cell('2026-10-21').classList.contains('today')).toBe(true)
    expect(cell('2026-10-21').classList.contains('sel')).toBe(true)
    expect(cell('2026-10-21').getAttribute('aria-pressed')).toBe('true')
    expect(cell('2026-10-28').querySelector('.anchor')).toBeTruthy()
    expect(cell('2026-10-27').querySelector('.anchor')).toBeNull()
    expect(dayCard().textContent).toContain('Сегодня, 21 октября')
  })

  it('‹ › switch the month: title, cells and the month total follow', async () => {
    await seed({}, [
      { kind: 'expense', amount: 99, date: '2026-09-30' },
      { kind: 'expense', amount: 10, date: '2026-10-02' },
    ])
    renderCalendar()
    await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    await screen.findByText('За месяц $10')
    fireEvent.click(screen.getByRole('button', { name: 'Предыдущий месяц' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Сентябрь 2026' })).toBeTruthy()
    expect(screen.getByText('За месяц $99')).toBeTruthy()
    expect(cell('2026-09-30').querySelector('.dv')!.textContent).toBe('$99')
    expect(cell('2026-10-02')).toBeNull()
    expect(document.querySelectorAll('.day').length).toBe(30)
    fireEvent.click(screen.getByRole('button', { name: 'Следующий месяц' }))
    fireEvent.click(screen.getByRole('button', { name: 'Следующий месяц' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Ноябрь 2026' })).toBeTruthy()
    expect(cell('2026-11-01').disabled).toBe(true)
  })
})

describe('Calendar: the day card', () => {
  it('picking a day swaps only the card: the title and the grid stay the same DOM nodes', async () => {
    await seed({}, [
      { kind: 'expense', amount: 12.4, date: '2026-10-05', note: 'кофе' },
      { kind: 'expense', amount: 7.7, date: '2026-10-05', note: 'булка' },
    ])
    renderCalendar()
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    await waitFor(() => expect(cell('2026-10-05').querySelector('.dv')!.textContent).toBe('$20'))
    const grid = document.querySelector('.cal')
    const target = cell('2026-10-05')
    expect(dayCard().textContent).toContain('В этот день трат не было')

    fireEvent.click(target)

    expect(screen.getByRole('heading', { level: 1 })).toBe(h1)
    expect(document.querySelector('.cal')).toBe(grid)
    expect(cell('2026-10-05')).toBe(target)
    expect(target.classList.contains('sel')).toBe(true)
    expect(cell('2026-10-21').classList.contains('sel')).toBe(false)
    expect(cell('2026-10-21').classList.contains('today')).toBe(true)
    const card = dayCard()
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('5 октября')
    expect(card.querySelector('.cd-sum')!.textContent).toBe('$20.10')
    expect(card.querySelector('.cd-cats')!.textContent).toContain('$20.10')
    expect(within(card).getByText('Кофе')).toBeTruthy()
    expect(within(card).getByText('Булка')).toBeTruthy()
  })

  it('an archived expense counts in the cell and the day sum, the note says so, the list hides it', async () => {
    await seed({}, [
      { kind: 'expense', amount: 10, date: '2026-10-05', note: 'кофе' },
      { kind: 'expense', amount: 5, date: '2026-10-05', note: 'тайное', archived: true },
    ])
    renderCalendar()
    await waitFor(() => expect(cell('2026-10-05').querySelector('.dv')!.textContent).toBe('$15'))
    fireEvent.click(cell('2026-10-05'))
    const card = dayCard()
    expect(card.querySelector('.cd-sum')!.textContent).toBe('$15')
    expect(within(card).getByText('Кофе')).toBeTruthy()
    expect(within(card).queryByText('Тайное')).toBeNull()
    expect(within(card).getByText('1 запись в архиве — в сумме дня учтены')).toBeTruthy()
  })

  it('a day whose records are all archived says so', async () => {
    await seed({}, [
      { kind: 'expense', amount: 3, date: '2026-10-07', archived: true },
      { kind: 'expense', amount: 4, date: '2026-10-07', archived: true },
    ])
    renderCalendar()
    await waitFor(() => expect(cell('2026-10-07').querySelector('.dv')!.textContent).toBe('$7'))
    fireEvent.click(cell('2026-10-07'))
    expect(dayCard().textContent).toContain('Все записи этого дня в архиве')
    expect(dayCard().textContent).toContain('2 записи в архиве — в сумме дня учтены')
  })

  it('a future day cannot be picked', async () => {
    await seed({})
    renderCalendar()
    await waitFor(() => expect(cell('2026-10-25')).toBeTruthy())
    fireEvent.click(cell('2026-10-25'))
    expect(cell('2026-10-21').classList.contains('sel')).toBe(true)
    expect(cell('2026-10-25').classList.contains('sel')).toBe(false)
  })
})
