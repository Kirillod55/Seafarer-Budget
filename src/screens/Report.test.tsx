import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Author, FxRate, Settings } from '@shared/types.ts'
import { Report } from './Report.tsx'
import { Records } from './Records.tsx'
import { RecordSheetHost } from './RecordSheet.tsx'
import { Navigator } from '../nav/Navigator.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// TEST_TODAY is 2026-10-21.
const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let accountId: string
const cat: Record<string, string> = {}

async function expense(
  amount: number,
  currency: string,
  date: string,
  category: string | null,
  note = '',
  extra: { author?: Author; archived?: boolean } = {},
) {
  return env.repo.addTransaction({
    kind: 'expense',
    amount,
    currency,
    account_id: accountId,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: category ? cat[category] : null,
    date,
    note,
    source: 'app',
    author: extra.author ?? 'owner',
    archived: extra.archived ?? false,
  })
}

/** October 2026 expenses total $480; per category: Продукты 300, Транспорт 100, без категории 50 (2000 UAH), Кафе 30. */
async function seedOctober() {
  await expense(200, 'USD', '2026-10-02', 'Продукты')
  await expense(100, 'USD', '2026-10-09', 'Продукты')
  await expense(100, 'USD', '2026-10-05', 'Транспорт и такси')
  await expense(2000, 'UAH', '2026-10-12', null, 'наличные')
  await expense(20, 'USD', '2026-10-15', 'Кафе и рестораны')
  await expense(10, 'USD', '2026-10-16', 'Кафе и рестораны')
}

/** Kirill: Продукты 200, Транспорт 100; Masha: Продукты 100, Кафе 30. */
async function seedTwoPeople() {
  await expense(200, 'USD', '2026-10-02', 'Продукты')
  await expense(100, 'USD', '2026-10-03', 'Продукты', 'рынок', { author: 'partner' })
  await expense(100, 'USD', '2026-10-05', 'Транспорт и такси')
  await expense(30, 'USD', '2026-10-06', 'Кафе и рестораны', 'кофе', { author: 'partner' })
}

function renderReport() {
  return renderWithApp(
    <RecordSheetHost>
      <Navigator renderScreen={(r) => (r.screen === 'records' ? <Records /> : <Report />)} />
    </RecordSheetHost>,
    env,
  )
}

const usd = (s: string | null | undefined) => Number((s ?? '').replace(/[^0-9.]/g, ''))
/** The visible screen (lower ones stay mounted, hidden). */
const top = () => document.querySelector<HTMLElement>('.app > .screen:not(.below)')!
const catRows = () => within(screen.getByRole('list', { name: 'Категории' })).getAllByRole('button')
const rowMap = () => Object.fromEntries(catRows().map((r) => [r.querySelector('.lname')!.textContent, usd(r.querySelector('.lsum')!.textContent)]))
const monthTotal = () => usd(top().querySelector('.rtile b')!.textContent)

beforeEach(async () => {
  env = makeEnv()
  await env.repo.initDefaults('single', [{ currency: 'USD', amount: 100 }])
  await env.db.fx_rates.bulkPut([rate('2026-10-01', 'UAH', 1), rate('2026-10-01', 'USD', 40)] as FxRate[])
  accountId = (await env.db.accounts.toCollection().first())!.id
  for (const c of await env.db.categories.toArray()) cat[c.name] = c.id
  const s = (await env.db.settings.toCollection().first())!
  await env.repo.put<Settings>('settings', { id: s.id, partner_name: 'Маша' })
})

describe('Report', () => {
  it('lists categories by descending spend with USD amounts and shares, «Без категории» included', async () => {
    await seedOctober()
    renderReport()

    expect(await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })).toBeTruthy()
    await waitFor(() => expect(catRows()).toHaveLength(4))
    const rows = catRows()
    expect(rows.map((r) => r.querySelector('.lname')!.textContent)).toEqual([
      'Продукты',
      'Транспорт и такси',
      'Без категории',
      'Кафе и рестораны',
    ])
    expect(rows[0].textContent).toContain('$300')
    expect(rows[0].textContent).toContain('63%')
    expect(rows[1].textContent).toContain('$100')
    expect(rows[1].textContent).toContain('21%')
    expect(rows[2].textContent).toContain('$50')
    expect(rows[2].textContent).toContain('10%')
    expect(rows[3].textContent).toContain('$30')
    expect(rows[3].textContent).toContain('6%')
    expect(monthTotal()).toBe(480)
    // one sector per category; the centre shows the largest one by default
    expect(document.querySelectorAll('.arc')).toHaveLength(4)
    const centre = document.querySelector('.dcenter')!
    expect(centre.textContent).toContain('63%')
    expect(centre.textContent).toContain('Продукты')
    expect(centre.textContent).toContain('$300')
  })

  it('says «↑ на 20% больше, чем в сентябре» when spending grew', async () => {
    await seedOctober()
    await expense(400, 'USD', '2026-09-20', 'Продукты')
    renderReport()
    expect(await screen.findByText('↑ на 20% больше, чем в сентябре')).toBeTruthy()
  })

  it('says «↓ на 20% меньше, чем в сентябре» when spending fell', async () => {
    await seedOctober()
    await expense(600, 'USD', '2026-09-20', 'Продукты')
    renderReport()
    expect(await screen.findByText('↓ на 20% меньше, чем в сентябре')).toBeTruthy()
  })

  it('says «В сентябре трат не было» when the previous month is empty', async () => {
    await seedOctober()
    renderReport()
    expect(await screen.findByText('В сентябре трат не было')).toBeTruthy()
    expect(screen.queryByText(/больше, чем|меньше, чем/)).toBeNull()
  })

  it('«Все» = «Я» + «Маша» by total and by every category; «Все» rows carry «Я $X · Маша $Y»', async () => {
    await seedTwoPeople()
    renderReport()
    await waitFor(() => expect(catRows()).toHaveLength(3))

    const all = { total: monthTotal(), rows: rowMap() }
    const prod = catRows().find((r) => r.textContent!.includes('Продукты'))!
    expect(prod.querySelector('.lsplit')!.textContent).toBe('Я $200 · Маша $100')
    // the «Я / Маша» tile
    expect(top().textContent).toContain('Я $300 · Маша $130')

    fireEvent.click(screen.getByRole('button', { name: 'Я' }))
    await waitFor(() => expect(catRows()).toHaveLength(2))
    const me = { total: monthTotal(), rows: rowMap() }
    expect(document.querySelector('.lsplit')).toBeNull()
    expect(top().textContent).toContain('Мои расходы')

    fireEvent.click(screen.getByRole('button', { name: 'Маша' }))
    await waitFor(() => expect(catRows()).toHaveLength(2))
    const her = { total: monthTotal(), rows: rowMap() }
    expect(top().textContent).toContain('Расходы: Маша')

    expect(all.total).toBe(430)
    expect(me.total + her.total).toBe(all.total)
    for (const [name, v] of Object.entries(all.rows)) expect((me.rows[name] ?? 0) + (her.rows[name] ?? 0)).toBe(v)
    expect(me.rows).toEqual({ Продукты: 200, 'Транспорт и такси': 100 })
    expect(her.rows).toEqual({ Продукты: 100, 'Кафе и рестораны': 30 })
  })

  it('a tap on a sector opens «Расходы» of that category for the shown month; «‹ Отчёт» comes back', async () => {
    await seedOctober()
    await expense(70, 'USD', '2026-09-20', 'Транспорт и такси', 'автобус')
    await expense(250, 'USD', '2026-09-21', 'Продукты')
    renderReport()
    await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    fireEvent.click(screen.getByRole('button', { name: 'Сентябрь' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Сентябрь 2026' })).toBeTruthy()
    await waitFor(() => expect(document.querySelectorAll('.arc')).toHaveLength(2))

    fireEvent.click(document.querySelector('.arc[data-arc="1"]')!) // the second largest: Транспорт

    expect(await screen.findByRole('heading', { level: 1, name: 'Транспорт и такси' })).toBeTruthy()
    expect(within(top()).getByText('Сентябрь 2026')).toBeTruthy()
    await waitFor(() => expect(within(top()).getByText('Автобус')).toBeTruthy())
    expect(within(top()).queryByText('Продукты')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Назад, Отчёт' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Сентябрь 2026' })).toBeTruthy()
  })

  it('a tap on a category row opens its «Расходы» too', async () => {
    await seedOctober()
    renderReport()
    await waitFor(() => expect(catRows()).toHaveLength(4))
    fireEvent.click(screen.getByRole('button', { name: 'Кафе и рестораны: открыть траты' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Кафе и рестораны' })).toBeTruthy()
    expect(await within(top()).findByText(/2 записи на \$30/)).toBeTruthy()
  })

  it('with «Маша» chosen, a category row opens «Расходы» with «Маша» pressed and only her records', async () => {
    await seedTwoPeople()
    renderReport()
    await waitFor(() => expect(catRows()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Маша' }))
    await waitFor(() => expect(catRows()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Продукты: открыть траты' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Продукты' })).toBeTruthy()
    const who = within(top()).getByRole('group', { name: 'Чьи траты' })
    expect(within(who).getByRole('button', { name: 'Маша' }).getAttribute('aria-pressed')).toBe('true')
    expect(await within(top()).findByText(/1 запись на \$100/)).toBeTruthy()
    expect(top().querySelector('.tx')!.textContent).toContain('Рынок')
    expect(top().querySelectorAll('.tx')).toHaveLength(1)
  })

  it('the «Расходы за месяц» tile opens all the month records', async () => {
    await seedOctober()
    renderReport()
    await waitFor(() => expect(catRows()).toHaveLength(4))
    fireEvent.click(screen.getByRole('button', { name: 'Расходы за месяц: все записи месяца' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Расходы' })).toBeTruthy()
    expect(await within(top()).findByText('6 записей на $480')).toBeTruthy()
  })

  it('«Самая крупная трата» opens that record in the sheet', async () => {
    await seedOctober()
    renderReport()
    const tile = await screen.findByRole('button', { name: 'Открыть самую крупную трату' })
    expect(tile.textContent).toContain('$200')
    expect(tile.textContent).toContain('Продукты')
    fireEvent.click(tile)
    const sheet = await screen.findByRole('dialog', { name: 'Запись' })
    expect((within(sheet).getByLabelText('Сумма') as HTMLInputElement).value).toBe('200')
  })

  it('«Самые крупные траты» lists the top five as rows, largest first; an archived one counts but is not listed', async () => {
    await seedOctober()
    await expense(500, 'USD', '2026-10-10', 'Продукты', 'тайное', { archived: true })
    renderReport()
    const list = await screen.findByRole('region', { name: 'Самые крупные траты' })
    await waitFor(() => expect(list.querySelectorAll('.swipe')).toHaveLength(5))
    const amounts = [...list.querySelectorAll('.tx .a')].map((a) => a.textContent)
    expect(amounts[0]).toBe('$200')
    expect(amounts[3]).toContain('₴2,000') // $50 by the month's rate
    expect(within(list).queryByText('Тайное')).toBeNull()
    expect(monthTotal()).toBe(980)
  })

  it('‹ › switch the month', async () => {
    await seedOctober()
    await expense(250, 'USD', '2026-09-20', 'Продукты')
    renderReport()
    await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })
    expect(screen.getByRole('button', { name: 'Ноябрь' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Сентябрь' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Сентябрь 2026' })).toBeTruthy()
    await waitFor(() => expect(catRows()).toHaveLength(1))
    expect(monthTotal()).toBe(250)
    expect(screen.getByText('В августе трат не было')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Октябрь' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Октябрь 2026' })).toBeTruthy()
  })

  it('an empty month says there were no expenses instead of drawing a ring', async () => {
    renderReport()
    expect(await screen.findByText('Трат в этом месяце нет')).toBeTruthy()
    expect(document.querySelector('.arc')).toBeNull()
  })
})
