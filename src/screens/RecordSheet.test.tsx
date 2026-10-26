import { readFileSync } from 'node:fs'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, FxRate, Settings, Transaction } from '@shared/types.ts'
import { RecordSheet, RecordSheetHost, useRecordSheet } from './RecordSheet.tsx'
import { lockScroll } from '../ui/scrollLock.ts'
import { spring } from '../ui/motion.ts'
import { ToastHost } from '../ui/Toast.tsx'
import { TEST_TODAY, makeEnv, renderWithApp, reducedMotion } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// the real springs, watched: the return spring's parameters are asserted
vi.mock('../ui/motion.ts', async (orig) => {
  const m = await orig<typeof import('../ui/motion.ts')>()
  return { ...m, spring: vi.fn(m.spring) }
})

const rate = (date: string, currency: string, uah_per_unit: number): FxRate => ({ date, currency, uah_per_unit })

let env: AppContextValue
let existing: Transaction
let cafe: Category

async function seed(mode: 'single' | 'multi' = 'single') {
  await env.repo.initDefaults(mode, [{ currency: 'USD', amount: 100 }])
  await env.db.fx_rates.bulkPut([rate(TEST_TODAY, 'UAH', 1), rate(TEST_TODAY, 'USD', 40)])
  const account = (await env.db.accounts.toCollection().first())!
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
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

async function settings(): Promise<Settings> {
  return (await env.db.settings.toCollection().first())!
}

function renderSheet(id?: string, onClose = vi.fn()) {
  renderWithApp(
    <>
      <RecordSheet open id={id} onClose={onClose} />
      <ToastHost />
    </>,
    env,
  )
  return onClose
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const chipNames = () =>
  within(screen.getByRole('group', { name: 'Категория' }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')

const touch = (x: number, y: number) => [{ clientX: x, clientY: y }]
let clock = 1000
/** A drag over the sheet from (x0, y0) through `points`, 100 ms per step (a slow pull, no flick). */
function drag(el: Element, [x0, y0]: [number, number], points: [number, number][]) {
  fireEvent.touchStart(el, { touches: touch(x0, y0) })
  for (const [x, y] of points) {
    clock += 100
    fireEvent.touchMove(el, { touches: touch(x, y) })
  }
  const [x, y] = points[points.length - 1]
  clock += 100
  fireEvent.touchEnd(el, { touches: [], changedTouches: touch(x, y) })
}

const SHEET_H = 600
let heightDesc: PropertyDescriptor | undefined

beforeEach(() => {
  env = makeEnv()
  reducedMotion(true)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => SHEET_H })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDesc)
  else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  delete document.documentElement.dataset.editing
  document.body.removeAttribute('style')
})

describe('lockScroll', () => {
  it('pins <body> at the current scroll and puts the page back exactly where it was', () => {
    window.scrollTo(0, 420)
    const unlock = lockScroll()
    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-420px')
    window.scrollTo(0, 0) // a fixed body scrolls the window to the top
    unlock()
    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
    expect(window.scrollY).toBe(420)
  })

  it('nested locks: only the outermost unlock restores; a second call of the same unlock is ignored', () => {
    window.scrollTo(0, 150)
    const a = lockScroll()
    const b = lockScroll()
    b()
    expect(document.body.style.position).toBe('fixed')
    a()
    a()
    expect(document.body.style.position).toBe('')
    expect(window.scrollY).toBe(150)
  })
})

describe('sheet CSS', () => {
  const sheetCss = readFileSync('src/ui/sheet.css', 'utf8')
  const recordCss = readFileSync('src/screens/record.css', 'utf8')

  it('every rule for fields in the sheet sets font-size ≥ 17 px (iOS never zooms on focus)', () => {
    const css = sheetCss + recordCss
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => /\binput\b|\btextarea\b|\bselect\b|\.inp\b/.test(sel))
    expect(rules.length).toBeGreaterThan(0)
    let sized = 0
    for (const [, sel, body] of rules) {
      const fs = /font-size:\s*([^;]+)/.exec(body)?.[1].trim()
      if (!fs) continue
      sized++
      const ok = /^max\(17px,/.test(fs) || (/^(\d+(\.\d+)?)px$/.test(fs) && parseFloat(fs) >= 17) || (/rem$/.test(fs) && parseFloat(fs) >= 1)
      expect(ok, `${sel.trim()} { font-size: ${fs} }`).toBe(true)
    }
    expect(sized).toBeGreaterThan(0)
  })

  it('uses only tokens for backgrounds, no hard-coded max-width 430px', () => {
    for (const css of [sheetCss, recordCss]) {
      expect(css).not.toMatch(/max-width:\s*430px/)
      for (const m of css.matchAll(/background(?:-color)?:\s*([^;]+);/g)) expect(m[1]).toMatch(/var\(--|transparent|none|color-mix\(in srgb, var\(--/)
    }
  })
})

describe('Sheet behaviour', () => {
  it('sets data-editing="1" on <html> while open and removes it after closing', async () => {
    await seed()
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    expect(document.documentElement.dataset.editing).toBe('1')
    expect(screen.getByRole('dialog', { name: 'Новая запись' }).getAttribute('aria-modal')).toBe('true')
    fireEvent.click(button('Отмена'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(document.documentElement.dataset.editing).toBeUndefined()
  })

  it('pins the page under it and returns it to the same scroll after closing', async () => {
    await seed()
    window.scrollTo(0, 333)
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    expect(document.body.style.position).toBe('fixed')
    window.scrollTo(0, 0)
    fireEvent.click(button('Отмена'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(document.body.style.position).toBe('')
    expect(window.scrollY).toBe(333)
  })

  it('a pull down by 30 % of its height from a field closes it without saving', async () => {
    await seed()
    const add = vi.spyOn(env.repo, 'addTransaction')
    const onClose = renderSheet()
    const amount = await screen.findByLabelText('Сумма')
    fireEvent.change(amount, { target: { value: '55' } })
    drag(amount, [100, 200], [
      [100, 215],
      [100, 215 + SHEET_H * 0.3],
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(add).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.editing).toBeUndefined()
  })

  it('a short pull springs back and keeps it open; a sideways or upward move does not touch it', async () => {
    await seed()
    const onClose = renderSheet()
    const amount = await screen.findByLabelText('Сумма')
    const sheet = screen.getByRole('dialog')
    drag(amount, [100, 200], [
      [100, 215],
      [100, 215 + SHEET_H * 0.1],
    ])
    await act(async () => {})
    expect(sheet.style.transform).toMatch(/translateY\(0(px)?\)|^$/)
    // «Закрытие/возврат — без отскока»: the spring back to the open place has damping 1
    expect(vi.mocked(spring)).toHaveBeenLastCalledWith(expect.objectContaining({ to: 0, damping: 1, response: 0.3 }))
    drag(amount, [100, 200], [
      [160, 210],
      [300, 400],
    ])
    drag(amount, [100, 400], [
      [100, 380],
      [100, 100],
    ])
    await act(async () => {})
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBe(sheet)
  })

  it('a pull does not count as a tap on the category under the finger', async () => {
    await seed()
    renderSheet()
    await screen.findByLabelText('Сумма')
    const chip = screen.getByRole('button', { name: 'Продукты' })
    drag(chip, [100, 200], [
      [100, 215],
      [100, 240],
    ])
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('while a save is in flight, a backdrop tap, Esc and a pull do not close it; it closes once after the save', async () => {
    await seed()
    let done: (v: Transaction) => void = () => {}
    vi.spyOn(env.repo, 'addTransaction').mockImplementation(() => new Promise<Transaction>((r) => (done = r)))
    const onClose = renderSheet()
    const amount = await screen.findByLabelText('Сумма')
    fireEvent.change(amount, { target: { value: '9' } })
    fireEvent.click(button('Добавить'))
    await act(async () => {})
    fireEvent.click(document.querySelector('.backdrop')!)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    drag(amount, [100, 200], [
      [100, 215],
      [100, 215 + SHEET_H * 0.5],
    ])
    await act(async () => {})
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').style.transform).toBe('')
    await act(async () => done(existing))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('a tap on the dimmed backdrop and Esc close it', async () => {
    await seed()
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    fireEvent.click(document.querySelector('.backdrop')!)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('Esc closes it, but not while a menu inside handles its own Esc', async () => {
    await seed()
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    fireEvent.click(screen.getByLabelText('Валюта'))
    const menu = await screen.findByRole('listbox')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('while closing it takes no taps: a second close is ignored', async () => {
    await seed()
    reducedMotion(false)
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    fireEvent.click(button('Отмена'))
    await waitFor(() => expect(screen.getByRole('dialog', { hidden: true }).className).toContain('closing'))
    expect(document.querySelector('.backdrop')!.className).toContain('closing')
    expect(onClose).not.toHaveBeenCalled() // still sliding away
    fireEvent.click(document.querySelector('.backdrop')!)
    fireEvent.click(screen.getByRole('button', { name: 'Отмена', hidden: true }))
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 400))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('RecordSheet', () => {
  it('a double tap on «Добавить» creates one record', async () => {
    await seed()
    const onClose = renderSheet()
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '12' } })
    fireEvent.click(button('Добавить'))
    fireEvent.click(button('Добавить'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await env.db.transactions.count()).toBe(3) // opening adjustment + the seeded expense + one new
  })

  it('a double tap on «Готово» saves the edit once', async () => {
    await seed()
    const update = vi.spyOn(env.repo, 'updateTransaction')
    const onClose = renderSheet(existing.id)
    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('80'))
    fireEvent.change(amount, { target: { value: '90' } })
    fireEvent.click(button('Готово'))
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('a new record: «Моя» by default — author owner, archived false, today, default currency, no category', async () => {
    await seed()
    const add = vi.spyOn(env.repo, 'addTransaction')
    const onClose = renderSheet()
    const amount = await screen.findByLabelText('Сумма')
    expect(screen.getByRole('heading', { name: 'Новая запись' })).toBeTruthy()
    expect((screen.getByLabelText('Валюта') as HTMLButtonElement).value).toBe('UAH')
    expect((screen.getByLabelText('Дата') as HTMLInputElement).value).toBe(TEST_TODAY)
    expect(within(screen.getByRole('group', { name: 'Чья трата' })).getByRole('button', { name: 'Моя' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Удалить запись' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'В архив' })).toBeNull()
    fireEvent.change(amount, { target: { value: '12,5' } })
    fireEvent.click(button('Добавить'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'expense',
        amount: 12.5,
        currency: 'UAH',
        date: TEST_TODAY,
        source: 'app',
        category_id: null,
        author: 'owner',
        archived: false,
      }),
    )
  })

  it('«Чья трата: Маша» saves author partner (the name comes from the settings)', async () => {
    await seed()
    await env.repo.put<Settings>('settings', { id: (await settings()).id, partner_name: 'Маша' })
    const onClose = renderSheet()
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '7' } })
    fireEvent.click(within(screen.getByRole('group', { name: 'Чья трата' })).getByRole('button', { name: 'Маша' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    fireEvent.click(button('Добавить'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const tx = (await env.db.transactions.toArray()).find((t) => t.amount === 7)!
    expect(tx).toMatchObject({ author: 'partner', archived: false, category_id: expect.any(String) })
  })

  it('editing can reassign a record to the partner and back', async () => {
    await seed()
    await env.db.transactions.update(existing.id, { author: 'partner' })
    const onClose = renderSheet(existing.id)
    await screen.findByLabelText('Сумма')
    const who = within(screen.getByRole('group', { name: 'Чья трата' }))
    await waitFor(() => expect(who.getByRole('button', { name: 'Она' }).getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(who.getByRole('button', { name: 'Моя' }))
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((await env.db.transactions.get(existing.id))!.author).toBe('owner')
  })

  it('opens an existing expense; 80 → 120 saves with recomputed amount_usd and dirty:1', async () => {
    await seed()
    await env.db.transactions.update(existing.id, { dirty: 0 })
    const onClose = renderSheet(existing.id)
    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('80'))
    expect(screen.getByRole('heading', { name: 'Запись' })).toBeTruthy()
    expect((screen.getByLabelText('Заметка') as HTMLInputElement).value).toBe('кофе')
    expect((screen.getByLabelText('Валюта') as HTMLButtonElement).value).toBe('UAH')
    expect(screen.getByRole('button', { name: 'Кафе и рестораны' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(amount, { target: { value: '120' } })
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await env.db.transactions.get(existing.id)).toMatchObject({
      amount: 120,
      amount_usd: 3,
      dirty: 1,
      note: 'кофе',
      category_id: cafe.id,
    })
    expect(await env.db.transactions.count()).toBe(2)
  })

  it('editing a record whose category is in the bin keeps its category_id and shows it as a muted selected pill', async () => {
    await seed()
    await env.repo.remove('categories', cafe.id)
    const onClose = renderSheet(existing.id)
    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('80'))
    const pill = screen.getByRole('button', { name: 'Кафе и рестораны' })
    expect(pill.getAttribute('aria-pressed')).toBe('true')
    expect(pill.classList.contains('gone')).toBe(true)
    // a tap clears it, the pill stays to be chosen again; a second tap brings it back
    fireEvent.click(pill)
    expect(screen.getByRole('button', { name: 'Кафе и рестораны' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Кафе и рестораны' }))
    expect(screen.getByRole('button', { name: 'Продукты' }).classList.contains('gone')).toBe(false)
    fireEvent.change(amount, { target: { value: '81' } })
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await env.db.transactions.get(existing.id)).toMatchObject({ amount: 81, category_id: cafe.id })
  })

  it('offers only alive, non-archived categories of the chosen kind; «Доход» swaps them', async () => {
    await seed()
    await env.repo.put<Category>('categories', { ...cafe, archived: true })
    const prod = (await env.db.categories.toArray()).find((c) => c.name === 'Транспорт и такси')!
    await env.repo.remove('categories', prod.id)
    renderSheet()
    await screen.findByLabelText('Сумма')
    await waitFor(() => expect(chipNames()).toContain('Продукты'))
    expect(chipNames()).not.toContain('Кафе и рестораны')
    expect(chipNames()).not.toContain('Транспорт и такси')
    expect(chipNames()).not.toContain('Зарплата')

    fireEvent.click(within(screen.getByRole('group', { name: 'Тип записи' })).getByRole('button', { name: 'Доход' }))
    expect(chipNames()).toEqual(['Зарплата', 'Прочий доход'])
  })

  it('a category tap selects it and a second tap clears it; switching the kind drops a category of the other kind', async () => {
    await seed()
    const add = vi.spyOn(env.repo, 'addTransaction')
    const onClose = renderSheet()
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '3' } })
    const food = screen.getByRole('button', { name: 'Продукты' })
    fireEvent.click(food)
    expect(food.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Продукты' })).toBe(food) // repainted, not re-rendered
    fireEvent.click(food)
    expect(food.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(food)
    const kind = within(screen.getByRole('group', { name: 'Тип записи' }))
    fireEvent.click(kind.getByRole('button', { name: 'Доход' }))
    fireEvent.click(kind.getByRole('button', { name: 'Расход' }))
    expect(screen.getByRole('button', { name: 'Продукты' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button('Добавить'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ category_id: null, kind: 'expense' }))
  })

  it('an empty amount and an empty date are rejected and the sheet stays open', async () => {
    await seed()
    const add = vi.spyOn(env.repo, 'addTransaction')
    const onClose = renderSheet()
    await screen.findByLabelText('Сумма')
    fireEvent.click(button('Добавить'))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '' } })
    fireEvent.click(button('Добавить'))
    expect(await screen.findByText('Укажите дату')).toBeTruthy()
    expect(add).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a new currency from «Другая валюта…» is chosen and kept in settings.currencies', async () => {
    await seed()
    const add = vi.spyOn(env.repo, 'addTransaction')
    const onClose = renderSheet()
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '20' } })
    fireEvent.click(screen.getByLabelText('Валюта'))
    fireEvent.click(await screen.findByRole('option', { name: /Другая валюта/ }))
    const dlg = await screen.findByRole('dialog', { name: 'Другая валюта' })
    fireEvent.change(within(dlg).getByLabelText('Код валюты'), { target: { value: 'gel' } })
    fireEvent.click(within(dlg).getByRole('button', { name: 'Добавить' }))
    await waitFor(async () => expect((await settings()).currencies).toContain('GEL'))
    expect((screen.getByLabelText('Валюта') as HTMLButtonElement).value).toBe('GEL')
    fireEvent.click(screen.getAllByRole('button', { name: 'Добавить' })[0])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GEL', amount: 20 }))
  })

  it('«Счёт» is hidden in single mode and offers the non-archived accounts in multi mode', async () => {
    await seed('multi')
    await env.repo.put<Account>('accounts', { name: 'Карта', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.put<Account>('accounts', { name: 'Старый', aliases: [], is_default: false, archived: true, sort: 2 })
    const onClose = renderSheet(existing.id)
    fireEvent.click(await screen.findByLabelText('Счёт'))
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent)
    // each account with its balance in whole dollars: $100 opening − ₴80 (= $2) on «Основной»
    expect(names).toEqual(['Основной≈ $98', 'Карта≈ $0'])
    fireEvent.click(screen.getByRole('option', { name: /Карта/ }))
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const card = (await env.db.accounts.toArray()).find((a) => a.name === 'Карта')!
    expect((await env.db.transactions.get(existing.id))!.account_id).toBe(card.id)
  })

  it('single mode has no «Счёт»', async () => {
    await seed('single')
    renderSheet(existing.id)
    await screen.findByLabelText('Сумма')
    expect(screen.queryByLabelText('Счёт')).toBeNull()
  })

  it('«Удалить запись» asks first; «Нет» backs out; «Удалить» soft-deletes with «Отменить» in a toast', async () => {
    await seed()
    const remove = vi.spyOn(env.repo, 'remove')
    const onClose = renderSheet(existing.id)
    await screen.findByLabelText('Сумма')
    fireEvent.click(button('Удалить запись'))
    expect(screen.getByText('Удалить эту запись?')).toBeTruthy()
    fireEvent.click(button('Нет'))
    expect(screen.queryByText('Удалить эту запись?')).toBeNull()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(button('Удалить запись'))
    fireEvent.click(button('Удалить'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('transactions', existing.id))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect((await env.db.transactions.get(existing.id))!.deleted_at).toEqual(expect.any(String))
    expect(await screen.findByText('Запись удалена')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.transactions.get(existing.id))!.deleted_at).toBeNull())
  })

  it('«В архив» archives the record with «Отменить» in a toast', async () => {
    await seed()
    const onClose = renderSheet(existing.id)
    await screen.findByLabelText('Сумма')
    fireEvent.click(button('В архив'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    await waitFor(async () => expect((await env.db.transactions.get(existing.id))!.archived).toBe(true))
    expect(await screen.findByText('Запись в архиве')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.transactions.get(existing.id))!.archived).toBe(false))
  })

  // R22: editing rules by kind
  it('R22 adjustment: a signed amount -50 → -70 saves; currency and account are locked; no kind switch', async () => {
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
    await env.db.transactions.update(adj.id, { dirty: 0 })
    const onClose = renderSheet(adj.id)
    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('-50'))
    expect(amount.readOnly).toBe(false)
    expect((screen.getByLabelText('Валюта') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('group', { name: 'Тип записи' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Категория' })).toBeNull()

    fireEvent.change(amount, { target: { value: '-70' } })
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await env.db.transactions.get(adj.id)).toMatchObject({
      kind: 'adjustment',
      amount: -70,
      amount_usd: -70,
      currency: 'USD',
      account_id: account.id,
      dirty: 1,
    })
  })

  it('R22 adjustment: a zero amount is rejected', async () => {
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
    const onClose = renderSheet(adj.id)
    fireEvent.change(await screen.findByLabelText('Сумма'), { target: { value: '0' } })
    fireEvent.click(button('Готово'))
    expect(await screen.findByText('Введите сумму')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect((await env.db.transactions.get(adj.id))!.amount).toBe(-50)
  })

  it('R22 exchange: only date and note are editable; every money field is read-only and unchanged', async () => {
    await seed('multi')
    const from = (await env.db.accounts.toCollection().first())!
    const to = await env.repo.put<Account>('accounts', { name: 'Карта', aliases: [], is_default: false, archived: false, sort: 1 })
    const ex = await env.repo.addTransaction({
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
    await env.db.transactions.update(ex.id, { dirty: 0 })
    const onClose = renderSheet(ex.id)
    const amount = (await screen.findByLabelText('Сумма')) as HTMLInputElement
    expect(amount.readOnly).toBe(true)
    expect((screen.getByLabelText('Валюта') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Счёт зачисления') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Получено') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('group', { name: 'Категория' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Тип записи' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Чья трата' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Заметка'), { target: { value: 'обмен в банке' } })
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2026-10-20' } })
    fireEvent.click(button('Готово'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await env.db.transactions.get(ex.id)).toMatchObject({
      kind: 'exchange',
      note: 'обмен в банке',
      date: '2026-10-20',
      amount: 4000,
      currency: 'UAH',
      account_id: from.id,
      to_account_id: to.id,
      to_amount: 100,
      to_currency: 'USD',
      dirty: 1,
    })
  })
})

describe('RecordSheetHost', () => {
  function Opener() {
    const { openRecord } = useRecordSheet()
    return (
      <>
        <button type="button" onClick={() => openRecord()}>
          new
        </button>
        <button type="button" onClick={() => openRecord(existing.id)}>
          edit
        </button>
      </>
    )
  }

  it('openRecord() opens the one sheet empty, openRecord(id) with that record; closing unmounts it', async () => {
    await seed()
    renderWithApp(
      <RecordSheetHost>
        <Opener />
      </RecordSheetHost>,
      env,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'new' }))
    expect(((await screen.findByLabelText('Сумма')) as HTMLInputElement).value).toBe('')
    expect(document.documentElement.dataset.editing).toBe('1')
    fireEvent.click(button('Отмена'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.documentElement.dataset.editing).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: 'edit' }))
    await waitFor(() => expect((screen.getByLabelText('Сумма') as HTMLInputElement).value).toBe('80'))
  })
})
