import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, FxRate, Goal, Settings as SettingsRow } from '@shared/types.ts'
import { More } from './More.tsx'
import { Shell } from '../Shell.tsx'
import { Navigator, type Route } from '../nav/Navigator.tsx'
import { ToastHost } from '../ui/Toast.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

let env: AppContextValue
let main: Account
let cafe: Category

const rate = (currency: string, uah_per_unit: number): FxRate => ({ date: TEST_TODAY, currency, uah_per_unit })

async function seed(mode: 'single' | 'multi' = 'single') {
  await env.repo.initDefaults(mode, [{ currency: 'UAH', amount: 5000 }])
  main = (await env.db.accounts.toCollection().first())!
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
}

/** Spend `uah` hryvnia so the UAH balance becomes 5000 - uah. */
async function spend(uah: number, over: { author?: 'owner' | 'partner'; note?: string } = {}) {
  return env.repo.addTransaction({
    kind: 'expense',
    amount: uah,
    currency: 'UAH',
    account_id: main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cafe.id,
    date: TEST_TODAY,
    note: over.note ?? 'кофе',
    source: 'app',
    author: over.author ?? 'owner',
  })
}

const settingsRow = async () => (await env.db.settings.toCollection().first())!
/** Settings as the sync would push them: the edited fields since the last push. */
const changed = async () => (await settingsRow()) as SettingsRow & { _changed?: string[] }
/** Puts settings as if they came from the server: nothing pending. */
async function serverSettings(patch: Partial<SettingsRow>) {
  const s = await settingsRow()
  await env.db.settings.put({ ...s, ...patch, dirty: 0, _changed: undefined } as never)
}

const renderMore = (onSignOut = vi.fn()) =>
  renderWithApp(
    <>
      <Navigator renderScreen={(r: Route) => (r.screen === 'root' ? <More onSignOut={onSignOut} /> : <p>Экран {r.screen}</p>)} />
      <ToastHost />
    </>,
    env,
  )
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const card = (name: string) => screen.findByRole('region', { name })

beforeEach(() => {
  env = makeEnv()
})

// the download tests stub these; put the originals back so a throwing stub never leaks into the next test
const urlFns = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(URL, urlFns)
  document.documentElement.removeAttribute('data-theme')
})

describe('More: layout', () => {
  it('the large title «Ещё», then the menu rows, which push their screens', async () => {
    await seed()
    renderMore()
    expect(await screen.findByRole('heading', { level: 1, name: 'Ещё' })).toBeTruthy()
    for (const [name, screenName] of [
      ['Лимиты', 'limits'],
      ['Счета', 'accounts'],
      ['Категории', 'cats'],
      ['Архив', 'archive'],
    ] as const) {
      fireEvent.click(await screen.findByRole('button', { name }))
      expect(await screen.findByText(`Экран ${screenName}`)).toBeTruthy()
      fireEvent.click(document.querySelector<HTMLButtonElement>('.tabs .tab:last-child')!)
      await screen.findByRole('heading', { level: 1, name: 'Ещё' })
    }
  })

  it('«Архив · N» counts archived records, goals, categories and accounts (not the binned ones)', async () => {
    await seed('multi')
    const t1 = await spend(10)
    const t2 = await spend(20)
    await spend(30)
    await env.repo.setArchived(t1.id, true)
    await env.repo.setArchived(t2.id, true)
    await env.repo.remove('transactions', t2.id) // in the bin: not in the archive
    await env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 100, deadline: null, archived: true })
    await env.repo.put<Category>('categories', { id: cafe.id, archived: true })
    await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: true, sort: 1 })
    renderMore()
    const row = await screen.findByRole('button', { name: 'Архив · 4' })
    expect(row.textContent).toContain('4')
  })

  it('without settings (before the first-run setup) shows a hint', async () => {
    renderMore()
    expect(await screen.findByText('Сначала завершите настройку')).toBeTruthy()
  })
})

describe('More: «Бюджет до посадки»', () => {
  it('a new reserve is saved alone: only reserve_usd is pending for the sync', async () => {
    await seed()
    await serverSettings({ next_contract_date: '2026-12-20', reserve_usd: 0 })
    renderMore()
    const reserve = await screen.findByLabelText('Запас, $')
    fireEvent.change(reserve, { target: { value: '500' } })
    fireEvent.blur(reserve)
    await waitFor(async () => expect((await changed()).reserve_usd).toBe(500))
    expect((await changed())._changed).toEqual(['reserve_usd'])
  })

  it('a new landing date is saved alone (next_contract_date only)', async () => {
    await seed()
    await serverSettings({ next_contract_date: null })
    renderMore()
    fireEvent.change(await screen.findByLabelText('Дата посадки'), { target: { value: '2026-12-20' } })
    await waitFor(async () => expect((await changed()).next_contract_date).toBe('2026-12-20'))
    expect((await changed())._changed).toEqual(['next_contract_date'])
  })

  it('an emptied date field (mid-edit) saves nothing; leaving it empty clears the date', async () => {
    await seed()
    await serverSettings({ next_contract_date: '2026-12-20' })
    renderMore()
    const field = await screen.findByLabelText('Дата посадки')
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('2026-12-20'))
    fireEvent.change(field, { target: { value: '' } })
    await new Promise((r) => setTimeout(r, 30))
    expect((await changed()).next_contract_date).toBe('2026-12-20')
    expect((await changed())._changed).toBeUndefined()
    fireEvent.change(field, { target: { value: '2026-12-21' } })
    await waitFor(async () => expect((await changed()).next_contract_date).toBe('2026-12-21'))
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    await waitFor(async () => expect((await changed()).next_contract_date).toBeNull())
    expect((await changed())._changed).toEqual(['next_contract_date'])
  })

  it('the live line: «$X в день на N дней» follows the typed reserve before it is saved', async () => {
    await seed()
    await env.db.fx_rates.bulkPut([rate('UAH', 1), rate('USD', 40)])
    // the opening balance from an earlier day (today's records do not count in the morning balance)
    await env.db.transactions.toCollection().modify({ date: '2026-10-01' })
    // 5000 ₴ = $125; 2026-10-21 → 2026-10-30 = 10 days
    await serverSettings({ next_contract_date: '2026-10-30', reserve_usd: 0 })
    renderMore()
    const calc = async () => (await card('Бюджет до посадки')).querySelector('.calc')!.textContent
    await waitFor(async () => expect(await calc()).toContain('$12.50 в день на 10 дней'))
    fireEvent.change(screen.getByLabelText('Запас, $'), { target: { value: '25' } })
    await waitFor(async () => expect(await calc()).toContain('= $10 в день на 10 дней'))
    expect(await calc()).toContain('к посадке останется $25')
  })

  it('no date: the line says the budget is not counted; a passed date says so', async () => {
    await seed()
    await serverSettings({ next_contract_date: null })
    const view = renderMore()
    expect(await screen.findByText('Без даты бюджет на день не считается')).toBeTruthy()
    view.unmount()
    await serverSettings({ next_contract_date: '2026-10-01' })
    renderMore()
    expect(await screen.findByText('Дата посадки уже прошла')).toBeTruthy()
  })

  it('a reserve that is not a number is not saved', async () => {
    await seed()
    await serverSettings({ reserve_usd: 100 })
    renderMore()
    const reserve = await screen.findByLabelText('Запас, $')
    fireEvent.change(reserve, { target: { value: 'abc' } })
    fireEvent.blur(reserve)
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect((await settingsRow()).reserve_usd).toBe(100)
  })
})

describe('More: «Оформление»', () => {
  it('«Тёмная» / «Светлая» set data-theme on <html> at once; «Авто» removes it; the choice is kept on the device', async () => {
    await seed()
    renderMore()
    const theme = await screen.findByRole('group', { name: 'Тема' })
    fireEvent.click(within(theme).getByRole('button', { name: 'Тёмная' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    fireEvent.click(within(theme).getByRole('button', { name: 'Светлая' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await waitFor(async () => expect((await env.db.meta.get('theme'))?.value).toBe('light'))
    fireEvent.click(within(theme).getByRole('button', { name: 'Авто' }))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(within(theme).getByRole('button', { name: 'Авто' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('More: «Режим счетов»', () => {
  it('single → multi → single writes only accounts_mode and keeps every account and record', async () => {
    await seed()
    await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await spend(80)
    await serverSettings({})
    renderMore()
    const mode = await screen.findByRole('group', { name: 'Режим счетов' })
    fireEvent.click(within(mode).getByRole('button', { name: 'Несколько счетов' }))
    await waitFor(async () => expect((await settingsRow()).accounts_mode).toBe('multi'))
    expect((await changed())._changed).toEqual(['accounts_mode'])
    fireEvent.click(within(mode).getByRole('button', { name: 'Один баланс' }))
    await waitFor(async () => expect((await settingsRow()).accounts_mode).toBe('single'))
    expect(await env.db.accounts.filter((a) => !a.deleted).count()).toBe(2)
    expect(await env.db.transactions.filter((t) => !t.deleted).count()).toBe(2)
  })
})

describe('More: «Валюты»', () => {
  it('adds PLN (lowercase is uppercased); the field empties', async () => {
    await seed()
    renderMore()
    fireEvent.change(await screen.findByLabelText('Добавить валюту'), { target: { value: 'pln' } })
    click('Добавить')
    await waitFor(async () => expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR', 'MDL', 'PLN']))
    expect(await screen.findByRole('button', { name: 'Убрать PLN' })).toBeTruthy()
    expect((screen.getByLabelText('Добавить валюту') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Курс берётся у НБУ — валюта должна быть в его списке')).toBeTruthy()
  })

  it.each(['PL', 'PLNN', '12A', 'ЗЛТ', ''])('rejects the code «%s»', async (code) => {
    await seed()
    renderMore()
    fireEvent.change(await screen.findByLabelText('Добавить валюту'), { target: { value: code } })
    click('Добавить')
    expect(await screen.findByText('Код валюты — 3 латинские буквы')).toBeTruthy()
    expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR', 'MDL'])
  })

  it('Enter in the field adds; a currency already in the list is rejected', async () => {
    await seed()
    renderMore()
    const input = await screen.findByLabelText('Добавить валюту')
    fireEvent.change(input, { target: { value: 'pln' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(async () => expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR', 'MDL', 'PLN']))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
    fireEvent.change(input, { target: { value: 'eur' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Такая валюта уже есть')).toBeTruthy()
  })

  it('each pill is a flip block, so adding or removing one re-flows smoothly', async () => {
    await seed()
    renderMore()
    const chips = (await card('Валюты')).querySelector('.mchips')!
    await waitFor(() => expect(chips.querySelectorAll('[data-flip-key]').length).toBe(4))
    expect([...chips.querySelectorAll<HTMLElement>('[data-flip-key]')].map((e) => e.dataset.flipKey)).toEqual([
      'cur-UAH', 'cur-USD', 'cur-EUR', 'cur-MDL',
    ])
  })

  it('the default currency cannot be removed (no ✕, and USD neither); another one can, writing only currencies', async () => {
    await seed()
    await serverSettings({})
    renderMore()
    const chips = await card('Валюты')
    await within(chips).findByText(/MDL/)
    expect(screen.queryByRole('button', { name: 'Убрать UAH' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Убрать USD' })).toBeNull()
    click('Убрать MDL')
    await waitFor(async () => expect((await settingsRow()).currencies).toEqual(['UAH', 'USD', 'EUR']))
    expect((await changed())._changed).toEqual(['currencies'])
  })

  it('a new default currency (picked in the menu) loses its ✕ and the old one gets it', async () => {
    await seed()
    renderMore()
    fireEvent.click(await screen.findByLabelText(/Валюта по умолчанию/))
    fireEvent.click(await screen.findByRole('option', { name: /EUR/ }))
    await waitFor(async () => expect((await settingsRow()).default_currency).toBe('EUR'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Убрать EUR' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Убрать UAH' })).toBeTruthy()
  })
})

describe('More: «Второй человек в боте»', () => {
  it('the name «маша» is saved as «Маша» (only partner_name) and changes the labels on «Главная»', async () => {
    await seed()
    await spend(40, { author: 'partner', note: 'мороженое' })
    await serverSettings({ partner_name: null })
    renderWithApp(<Shell onSignOut={vi.fn()} />, env)
    // before: «Она»
    expect(await screen.findByText('Она')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    const name = await screen.findByLabelText('Имя')
    fireEvent.change(name, { target: { value: 'маша' } })
    fireEvent.blur(name)
    await waitFor(async () => expect((await settingsRow()).partner_name).toBe('Маша'))
    expect((await changed())._changed).toEqual(['partner_name'])
    expect((name as HTMLInputElement).value).toBe('Маша')

    fireEvent.click(screen.getByRole('button', { name: 'Главная' }))
    expect(await screen.findByText('Маша')).toBeTruthy()
    expect(screen.queryByText('Она')).toBeNull()
  })

  it('«Ждём /start» until she has written to the bot, then «Подключена»; the name is at most 20 letters', async () => {
    await seed()
    await serverSettings({ partner_name: 'Маша', partner_seen_at: null })
    renderMore()
    const box = await card('Второй человек в боте')
    expect(within(box).getByText('Ждём /start')).toBeTruthy()
    expect((within(box).getByLabelText('Имя') as HTMLInputElement).maxLength).toBe(20)
    expect(box.textContent).toContain('Маша пишет траты боту')
    await serverSettings({ partner_seen_at: '2026-10-20T10:00:00Z' })
    expect(await within(box).findByText('Подключена')).toBeTruthy()
  })

  it('an empty name goes back to «Она» (null)', async () => {
    await seed()
    await serverSettings({ partner_name: 'Маша' })
    renderMore()
    const name = (await screen.findByLabelText('Имя')) as HTMLInputElement
    // the stored name first: otherwise its late arrival can overwrite the emptied field
    await waitFor(() => expect(name.value).toBe('Маша'))
    fireEvent.change(name, { target: { value: '  ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(async () => expect((await settingsRow()).partner_name).toBeNull())
  })

  it('a failed save puts the stored name back in the field', async () => {
    await seed()
    await serverSettings({ partner_name: 'Маша' })
    renderMore()
    const name = (await screen.findByLabelText('Имя')) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('Маша'))
    vi.spyOn(env.repo, 'put').mockRejectedValue(new Error('boom'))
    fireEvent.change(name, { target: { value: 'даша' } })
    fireEvent.blur(name)
    expect(await screen.findByText('Не получилось — попробуй ещё раз')).toBeTruthy()
    await waitFor(() => expect(name.value).toBe('Маша'))
    expect((await settingsRow()).partner_name).toBe('Маша')
  })
})

describe('More: «Telegram-бот»', () => {
  it('«Напоминать, если нет записей»: Выкл / 2 / 3 / 5 / 7 write remind_after_days only', async () => {
    await seed()
    await serverSettings({ remind_after_days: 2 })
    renderMore()
    const seg = await screen.findByRole('group', { name: 'Напоминание' })
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Выкл', '2', '3', '5', '7'])
    expect(within(seg).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(seg).getByRole('button', { name: '5' }))
    await waitFor(async () => expect((await settingsRow()).remind_after_days).toBe(5))
    expect((await changed())._changed).toEqual(['remind_after_days'])
    expect((await card('Telegram-бот')).textContent).toContain('5 дней')
    fireEvent.click(within(seg).getByRole('button', { name: 'Выкл' }))
    await waitFor(async () => expect((await settingsRow()).remind_after_days).toBe(0))
  })
})

describe('More: «Сверка»', () => {
  it('balance 4920 ₴, real 4800 ₴ creates an adjustment of −120 ₴ dated today', async () => {
    await seed()
    await spend(80)
    renderMore()
    expect(await within(await card('Сверка')).findByText(/₴4,920/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Реальный остаток UAH'), { target: { value: '4800' } })
    click('Сверить UAH')
    await waitFor(async () => {
      const adj = (await env.db.transactions.toArray()).filter((t) => t.kind === 'adjustment' && t.note === 'Сверка')
      expect(adj).toMatchObject([
        { amount: -120, currency: 'UAH', date: TEST_TODAY, category_id: null, account_id: main.id, deleted: false, dirty: 1 },
      ])
    })
    expect(await screen.findByText(/₴4,800/)).toBeTruthy()
  })

  it('lists the default currency and those with money in them, not empty ones', async () => {
    await seed()
    await env.repo.addTransaction({
      kind: 'income', amount: 7, currency: 'EUR', account_id: main.id, to_account_id: null, to_amount: null,
      to_currency: null, category_id: null, date: TEST_TODAY, note: '', source: 'app',
    })
    renderMore()
    await screen.findByLabelText('Реальный остаток UAH')
    expect(screen.getByLabelText('Реальный остаток EUR')).toBeTruthy()
    expect(screen.queryByLabelText('Реальный остаток USD')).toBeNull()
    expect(screen.queryByLabelText('Реальный остаток MDL')).toBeNull()
  })

  it('a decimal comma is accepted; a difference of 0 saves nothing', async () => {
    await seed()
    renderMore()
    fireEvent.change(await screen.findByLabelText('Реальный остаток UAH'), { target: { value: '5000' } })
    click('Сверить UAH')
    expect(await screen.findByText('Всё сходится, корректировка не нужна')).toBeTruthy()
    expect(await env.db.transactions.count()).toBe(1)
    fireEvent.change(screen.getByLabelText('Реальный остаток UAH'), { target: { value: '5000,5' } })
    click('Сверить UAH')
    await waitFor(async () =>
      expect((await env.db.transactions.toArray()).find((t) => t.note === 'Сверка')).toMatchObject({ amount: 0.5 }),
    )
  })

  it('an empty or non-numeric amount is rejected', async () => {
    await seed()
    renderMore()
    await screen.findByLabelText('Реальный остаток UAH')
    click('Сверить UAH')
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Реальный остаток UAH'), { target: { value: 'abc' } })
    click('Сверить UAH')
    expect(await env.db.transactions.count()).toBe(1)
  })

  it('multi mode reconciles per account and currency', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.addTransaction({
      kind: 'income', amount: 100, currency: 'USD', account_id: cash.id, to_account_id: null, to_amount: null,
      to_currency: null, category_id: null, date: TEST_TODAY, note: '', source: 'app',
    })
    renderMore()
    fireEvent.change(await screen.findByLabelText('Реальный остаток Наличные USD'), { target: { value: '90' } })
    click('Сверить Наличные USD')
    await waitFor(async () =>
      expect((await env.db.transactions.toArray()).find((t) => t.note === 'Сверка')).toMatchObject({
        amount: -10,
        currency: 'USD',
        account_id: cash.id,
      }),
    )
    expect((await env.db.transactions.toArray()).filter((t) => t.note === 'Сверка')).toHaveLength(1)
  })

  it('a failing save says so', async () => {
    await seed()
    renderMore()
    vi.spyOn(env.repo, 'addTransaction').mockRejectedValue(new Error('boom'))
    fireEvent.change(await screen.findByLabelText('Реальный остаток UAH'), { target: { value: '10' } })
    click('Сверить UAH')
    expect(await screen.findByText('Не получилось — попробуй ещё раз')).toBeTruthy()
  })
})

describe('More: «Резервная копия» and «Выйти»', () => {
  it('«Скачать CSV» downloads seafarer-budget-YYYY-MM-DD.csv with the CSV text', async () => {
    await seed()
    await spend(12.5)
    const created: Blob[] = []
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (created.push(b), 'blob:fake')), revokeObjectURL: vi.fn() })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download}|${this.href}`)
    })
    renderMore()
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать CSV' }))
    await waitFor(() => expect(downloads).toEqual(['seafarer-budget-2026-10-21.csv|blob:fake']))
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(created[0])
    })
    expect(text).toContain('Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка;Кто')
    expect(text).toContain('Расход;12,5;UAH;')
  })

  it('a failing download says so', async () => {
    await seed()
    Object.assign(URL, { createObjectURL: () => { throw new Error('boom') }, revokeObjectURL: vi.fn() })
    renderMore()
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать CSV' }))
    expect(await screen.findByText('Не получилось — попробуй ещё раз')).toBeTruthy()
  })

  it('«Выйти» calls onSignOut', async () => {
    await seed()
    const onSignOut = vi.fn()
    renderMore(onSignOut)
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
