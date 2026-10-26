import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from './Home.tsx'
import { RecordSheetHost } from './RecordSheet.tsx'
import { Navigator, type Route } from '../nav/Navigator.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'
import type { Goal, GoalMove, Settings, Transaction } from '@shared/types.ts'
import type { SchedulerStatus } from '../db/scheduler.ts'

// TEST_TODAY is Wednesday 2026-10-21.
let env: AppContextValue

type Tx = { kind: 'expense' | 'income'; amount: number; date: string; note?: string; archived?: boolean; author?: 'owner' | 'partner' }

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
        author: t.author ?? 'owner',
        archived: t.archived ?? false,
      }),
    )
  }
  return { settings: s, account, txs: out }
}

function Other({ route }: { route: Route }) {
  return <p>{`screen:${route.tab}/${route.screen}`}</p>
}

function renderHome() {
  return renderWithApp(
    <RecordSheetHost>
      <Navigator renderScreen={(r) => (r.tab === 'home' && r.screen === 'root' ? <Home /> : <Other route={r} />)} />
    </RecordSheetHost>,
    env,
  )
}

const card = () => document.querySelector('.daycard') as HTMLElement

beforeEach(() => {
  env = makeEnv()
})

describe('Home: the day card (§2 states)', () => {
  it('normal day: $59.67 a day, spent $36.68, «Осталось $22.99», «$60 ÷ 1 дн»', async () => {
    await seed({ next_contract_date: '2026-10-21', reserve_usd: 0 }, [
      { kind: 'income', amount: 59.67, date: '2026-10-01' },
      { kind: 'expense', amount: 36.68, date: '2026-10-21', note: 'кофе' },
    ])
    renderHome()
    expect(await screen.findByText('Осталось $22.99')).toBeTruthy()
    const c = card()
    expect(c.dataset.state).toBe('ok')
    expect(c.querySelector('.dc-limit')!.textContent).toBe('$59.67')
    expect(c.querySelector('.dc-spent')!.textContent).toBe('$36.68')
    expect(c.textContent).toContain('Потрачено сегодня')
    expect(c.textContent).toContain('Бюджет на день')
    expect(c.textContent).toContain('$60 ÷ 1 дн')
    const bar = c.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('61.5')
    expect(bar.getAttribute('data-level')).toBe('ok')
  })

  it('overspent: «Перерасход $10.33» in orange, the bar full and orange', async () => {
    await seed({ next_contract_date: '2026-10-21' }, [
      { kind: 'income', amount: 59.67, date: '2026-10-01' },
      { kind: 'expense', amount: 70, date: '2026-10-21' },
    ])
    renderHome()
    const over = await screen.findByText('Перерасход $10.33')
    expect(over.className).toContain('over-text')
    expect(card().dataset.state).toBe('overspent')
    const bar = card().querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('data-level')).toBe('over')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    expect(screen.queryByText(/Осталось/)).toBeNull()
  })

  it('spending the reserve: budget $0 and «Ты тратишь запас к посадке»', async () => {
    await seed({ next_contract_date: '2026-10-30', reserve_usd: 1000 }, [{ kind: 'income', amount: 500, date: '2026-10-01' }])
    renderHome()
    expect(await screen.findByText(/Ты тратишь запас к посадке/)).toBeTruthy()
    expect(card().dataset.state).toBe('reserve')
    expect(card().querySelector('.dc-limit')!.textContent).toBe('$0')
    expect(card().textContent).toContain('$0 ÷ 10 дн')
  })

  it('no landing date: «Укажи дату посадки»; the date is saved with only next_contract_date', async () => {
    const { settings } = await seed({ next_contract_date: null }, [
      { kind: 'income', amount: 1000, date: '2026-10-01' },
      { kind: 'expense', amount: 12.5, date: '2026-10-21' },
    ])
    const put = vi.spyOn(env.repo, 'put')
    renderHome()
    expect(await screen.findByText(/Укажи дату посадки/)).toBeTruthy()
    expect(card().dataset.state).toBe('no_date')
    expect(card().querySelector('.dc-spent')!.textContent).toBe('$12.50')
    expect(screen.queryByText('Бюджет на день')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Указать дату' }))
    fireEvent.change(screen.getByLabelText('Дата посадки'), { target: { value: '2026-12-20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(put).toHaveBeenCalledWith('settings', { id: settings.id, next_contract_date: '2026-12-20' }))
    expect(put).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(card().dataset.state).toBe('ok'))
  })

  it('at sea (today after the landing date): no budget, spent today and «Вернулся? Укажи новую дату посадки»', async () => {
    await seed({ next_contract_date: '2026-10-01' }, [
      { kind: 'income', amount: 1000, date: '2026-09-01' },
      { kind: 'expense', amount: 5, date: '2026-10-21' },
    ])
    renderHome()
    expect(await screen.findByText(/Вернулся\? Укажи новую дату посадки/)).toBeTruthy()
    expect(card().dataset.state).toBe('sea')
    expect(card().querySelector('.dc-spent')!.textContent).toBe('$5')
    expect(screen.queryByText('Бюджет на день')).toBeNull()
    expect(screen.getByRole('button', { name: 'Новая дата посадки' })).toBeTruthy()
  })

  it('an archived expense is not in the list but counts in «Потрачено сегодня»', async () => {
    await seed({ next_contract_date: '2026-10-21' }, [
      { kind: 'income', amount: 100, date: '2026-10-01' },
      { kind: 'expense', amount: 10, date: '2026-10-21', note: 'видно' },
      { kind: 'expense', amount: 7, date: '2026-10-21', note: 'спрятано', archived: true },
    ])
    renderHome()
    expect(await screen.findByText('Видно')).toBeTruthy()
    expect(screen.queryByText('Спрятано')).toBeNull()
    expect(card().querySelector('.dc-spent')!.textContent).toBe('$17')
  })
})

describe('Home: balance and the line under it', () => {
  it('reserve 0: no «Свободно» / «Запас», only the landing date «вс, 20 декабря»', async () => {
    await seed({ next_contract_date: '2026-12-20', reserve_usd: 0 }, [{ kind: 'income', amount: 3600, date: '2026-10-01' }])
    renderHome()
    expect(await screen.findByText('вс, 20 декабря')).toBeTruthy()
    const stats = document.querySelector('.stats')!
    expect(stats.children).toHaveLength(3)
    expect(stats.children[0].textContent).toBe('')
    expect(stats.children[1].textContent).toBe('')
    expect(stats.children[2].textContent).toContain('Посадка')
    expect(document.querySelector('.balance')!.textContent).toBe('$3,600')
  })

  it('with a reserve and goal money: «Свободно» = balance − goals − reserve, «Запас $1,000»', async () => {
    await seed({ next_contract_date: '2026-12-20', reserve_usd: 1000 }, [{ kind: 'income', amount: 5000, date: '2026-10-01' }])
    await env.repo.put<Goal>('goals', { id: 'g1', name: 'Машина', target_usd: 5000, deadline: null, archived: false, deleted_at: null, deleted_batch: null })
    await env.repo.put<GoalMove>('goal_moves', {
      id: 'm1', goal_id: 'g1', amount_usd: 150, date: '2026-10-02', note: '', author: 'owner', source: 'app', created_at: '2026-10-02T10:00:00.000Z',
    })
    renderHome()
    const stats = await waitFor(() => {
      const el = document.querySelector('.stats')!
      expect(el.children[0].textContent).toBe('Свободно$3,850')
      return el
    })
    expect(stats.children[1].textContent).toBe('Запас$1,000')
  })

  it('goals in the undo bin reserve nothing: after wipeAll the balance is $0, after restore it is back', async () => {
    await seed({ next_contract_date: '2026-12-20' }, [{ kind: 'income', amount: 3040, date: '2026-10-01' }])
    renderHome()
    const balance = () => document.querySelector('.balance')?.textContent
    await waitFor(() => expect(balance()).toBe('$3,040'))
    const { batch } = await env.repo.wipeAll()
    await waitFor(() => expect(balance()).toBe('$0'))
    await env.repo.restore(batch)
    await waitFor(() => expect(balance()).toBe('$3,040'))
  })
})

describe('Home: header and list', () => {
  it('the date pill opens the calendar; «＋» opens a new record; a row opens that record', async () => {
    await seed({ next_contract_date: '2026-12-20' }, [{ kind: 'expense', amount: 4, date: '2026-10-21', note: 'кофе' }])
    renderHome()
    fireEvent.click(await screen.findByRole('button', { name: 'Новая запись' }))
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(await screen.findByRole('button', { name: /кофе/i }))
    expect(await screen.findByRole('dialog', { name: 'Запись' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Сегодня, 21 октября/ }))
    expect(await screen.findByText('screen:home/calendar')).toBeTruthy()
  })

  it('a partner record shows her mark in the list', async () => {
    await seed({ next_contract_date: '2026-12-20', partner_name: 'Маша' }, [
      { kind: 'expense', amount: 4, date: '2026-10-21', note: 'кофе', author: 'partner' },
    ])
    renderHome()
    expect(await screen.findByText('Маша')).toBeTruthy()
    expect(document.querySelector('.who')!.textContent).toBe('М')
  })

  it('the list leaves out future-dated records', async () => {
    await seed({ next_contract_date: '2026-12-20' }, [
      { kind: 'expense', amount: 4, date: '2026-10-21', note: 'хлеб' },
      { kind: 'expense', amount: 9, date: '2026-10-25', note: 'потом' },
    ])
    renderHome()
    expect(await screen.findByText('Хлеб')).toBeTruthy()
    expect(screen.getByText('Сегодня')).toBeTruthy()
    expect(screen.queryByText('Потом')).toBeNull()
  })
})

describe('Home: pull to refresh', () => {
  const at = (y: number) => [{ clientX: 100, clientY: y }]
  function pull(dy: number) {
    const el = document.querySelector('.ptr-wrap')!
    fireEvent.touchStart(el, { touches: at(100) })
    fireEvent.touchMove(el, { touches: at(110) })
    fireEvent.touchMove(el, { touches: at(100 + dy) })
    fireEvent.touchEnd(el, { touches: [], changedTouches: at(100 + dy) })
  }
  const strip = () => document.querySelector('.ptr') as HTMLElement
  let online = true

  beforeEach(() => {
    online = true
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  })
  afterEach(() => vi.restoreAllMocks())

  it('past the threshold it syncs, then shows «Синхронизировано» and folds away', async () => {
    await seed({ next_contract_date: '2026-12-20' })
    const done: SchedulerStatus = { state: 'idle', lastSyncAt: 1, error: null }
    env.scheduler.syncNow = vi.fn(async () => done)
    renderHome()
    await screen.findByText('Баланс')
    act(() => pull(300))
    expect(env.scheduler.syncNow).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Синхронизировано')).toBeTruthy()
    await waitFor(() => expect(strip().dataset.phase).toBe('idle'), { timeout: 4000 })
    expect(strip().style.height).toBe('0px')
  })

  it('a short pull just goes back, nothing syncs', async () => {
    await seed({ next_contract_date: '2026-12-20' })
    env.scheduler.syncNow = vi.fn(async () => env.scheduler.status$.get())
    renderHome()
    await screen.findByText('Баланс')
    act(() => pull(40)) // 100·(1 − e^(−40/150)) ≈ 23 px < 54
    expect(env.scheduler.syncNow).not.toHaveBeenCalled()
    expect(strip().style.height).toBe('0px')
  })

  it('without a network: a short error, the strip folds away, nothing hangs', async () => {
    online = false
    await seed({ next_contract_date: '2026-12-20' })
    env.scheduler.syncNow = vi.fn(() => new Promise<SchedulerStatus>(() => {})) // would never answer
    renderHome()
    await screen.findByText('Баланс')
    act(() => pull(300))
    expect(await screen.findByText(/Нет сети/)).toBeTruthy()
    expect(strip().dataset.phase).toBe('error')
    expect(env.scheduler.syncNow).not.toHaveBeenCalled()
    await waitFor(() => expect(strip().dataset.phase).toBe('idle'), { timeout: 4000 })
    expect(strip().style.height).toBe('0px')
  })

  it('a failed sync shows a short error and folds away', async () => {
    await seed({ next_contract_date: '2026-12-20' })
    env.scheduler.syncNow = vi.fn(async (): Promise<SchedulerStatus> => ({ state: 'error', lastSyncAt: null, error: 'TypeError: Failed to fetch' }))
    renderHome()
    await screen.findByText('Баланс')
    act(() => pull(300))
    expect(await screen.findByText('Нет связи с сервером')).toBeTruthy()
    await waitFor(() => expect(strip().dataset.phase).toBe('idle'), { timeout: 4000 })
  })

  it('does nothing while the record sheet is open or the page is scrolled', async () => {
    await seed({ next_contract_date: '2026-12-20' })
    env.scheduler.syncNow = vi.fn(async () => env.scheduler.status$.get())
    renderHome()
    await screen.findByText('Баланс')
    document.documentElement.dataset.editing = '1'
    act(() => pull(300))
    delete document.documentElement.dataset.editing
    window.scrollTo(0, 120)
    act(() => pull(300))
    window.scrollTo(0, 0)
    expect(env.scheduler.syncNow).not.toHaveBeenCalled()
    expect(strip().dataset.phase).toBe('idle')
  })
})
