import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Category, Limit } from '@shared/types.ts'
import type { AppContextValue } from '../context.tsx'
import { Navigator, type Route } from '../nav/Navigator.tsx'
import { TEST_TODAY, makeEnv, renderWithApp, reducedMotion } from '../test-utils.tsx'
import { ToastHost } from '../ui/Toast.tsx'
import { Categories } from './Categories.tsx'

let env: AppContextValue
let accountId: string
const cat: Record<string, Category> = {}

/** Reduce Motion on: springs land at once, swiped rows collapse without waiting. */
const spend = (category: string, note = 'запись', archived = false) =>
  env.repo.addTransaction({
    kind: cat[category].kind,
    amount: 10,
    currency: 'USD',
    account_id: accountId,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cat[category].id,
    date: TEST_TODAY,
    note,
    source: 'app',
    archived,
  })

/** «Категории» in the navigator; the records route shows its params. */
function renderCats() {
  return renderWithApp(
    <>
      <Navigator
        renderScreen={(r: Route) =>
          r.screen === 'records' ? <p>{`Расходы ${r.category} ${r.month} ${r.from}`}</p> : <Categories />
        }
      />
      <ToastHost />
    </>,
    env,
  )
}

/** The row of a category by its name. */
async function rowOf(name: string): Promise<HTMLElement> {
  const t1 = await waitFor(() => {
    const el = [...document.querySelectorAll('.cats .t1')].find((e) => e.textContent === name)
    if (!el) throw new Error(`no row «${name}»`)
    return el
  })
  return t1.closest<HTMLElement>('.swipe')!
}

/** Opens a row's buttons from the keyboard and presses one. */
async function act2(name: string, button: 'Изменить' | 'В архив' | 'Удалить') {
  const row = await rowOf(name)
  fireEvent.keyDown(row.querySelector('.tx')!, { key: 'ArrowLeft' })
  fireEvent.click(await within(row).findByRole('button', { name: button }))
}

beforeEach(async () => {
  env = makeEnv()
  reducedMotion()
  await env.repo.initDefaults('single', [])
  accountId = (await env.db.accounts.toCollection().first())!.id
  for (const c of await env.db.categories.toArray()) cat[c.name] = c
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Категории: the list', () => {
  it('expenses and incomes, the number of records under each name; archived categories are not shown', async () => {
    await spend('Кафе и рестораны', 'кофе')
    await spend('Кафе и рестораны', 'обед', true)
    await spend('Зарплата')
    await env.repo.put<Category>('categories', { id: cat['Одежда'].id, archived: true })
    renderCats()

    expect((await rowOf('Кафе и рестораны')).querySelector('.t2')!.textContent).toBe('2 записи')
    expect((await rowOf('Зарплата')).querySelector('.t2')!.textContent).toBe('1 запись')
    expect((await rowOf('Продукты')).querySelector('.t2')!.textContent).toBe('Нет записей')
    expect([...document.querySelectorAll('.cats .section')].map((h) => h.textContent)).toEqual(['Расходы', 'Доходы'])
    expect(screen.queryByText('Одежда')).toBeNull()
  })

  it('«Прочее» and «Прочий доход» do not swipe and say «без категории попадают сюда»', async () => {
    renderCats()
    for (const name of ['Прочее', 'Прочий доход']) {
      const row = await rowOf(name)
      expect(row.hasAttribute('data-swipe-row')).toBe(false)
      expect(row.querySelector('.t2')!.textContent).toBe('Нет записей · без категории попадают сюда')
      expect(within(row).queryByRole('button', { name: 'Удалить' })).toBeNull()
    }
    expect((await rowOf('Продукты')).hasAttribute('data-swipe-row')).toBe(true)
  })

  it('a tap opens «Расходы» of that category for this month (from «Категории»)', async () => {
    renderCats()
    fireEvent.click((await rowOf('Продукты')).querySelector('.tx')!)
    expect(await screen.findByText(`Расходы ${cat['Продукты'].id} 2026-10 cats`)).toBeTruthy()
  })

  it('«Прочее» opens its records', async () => {
    renderCats()
    fireEvent.click((await rowOf('Прочее')).querySelector('.tx')!)
    expect(await screen.findByText(`Расходы ${cat['Прочее'].id} 2026-10 cats`)).toBeTruthy()
  })
})

describe('Категории: archive and delete', () => {
  it('«В архив»: the row goes, «Категория в архиве», «Отменить» brings it back', async () => {
    renderCats()
    await act2('Кафе и рестораны', 'В архив')

    await waitFor(async () => expect((await env.db.categories.get(cat['Кафе и рестораны'].id))!.archived).toBe(true))
    expect(await screen.findByText('Категория в архиве')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Кафе и рестораны')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.categories.get(cat['Кафе и рестораны'].id))!.archived).toBe(false))
    expect(await rowOf('Кафе и рестораны')).toBeTruthy()
  })

  it('«Удалить»: records go to «Прочее», the limit goes; «Отменить» brings back the category, its records and the limit', async () => {
    const t1 = await spend('Кафе и рестораны', 'кофе')
    const t2 = await spend('Кафе и рестораны', 'обед', true)
    await env.repo.put<Limit>('limits', { id: 'lim', category_id: cat['Кафе и рестораны'].id, monthly_usd: 100, deleted_at: null, deleted_batch: null })
    renderCats()
    await act2('Кафе и рестораны', 'Удалить')

    expect(await screen.findByText('Категория удалена, записи — в «Прочее»')).toBeTruthy()
    for (const t of [t1, t2]) expect((await env.db.transactions.get(t.id))!.category_id).toBe(cat['Прочее'].id)
    expect((await env.db.limits.get('lim'))!.deleted_at).toEqual(expect.any(String))
    await waitFor(() => expect(screen.queryByText('Кафе и рестораны')).toBeNull())
    expect((await rowOf('Прочее')).querySelector('.t2')!.textContent).toBe('2 записи · без категории попадают сюда')

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.categories.get(cat['Кафе и рестораны'].id))!.deleted_at).toBeNull())
    for (const t of [t1, t2]) expect((await env.db.transactions.get(t.id))!.category_id).toBe(cat['Кафе и рестораны'].id)
    expect((await env.db.limits.get('lim'))!.deleted_at).toBeNull()
    expect((await rowOf('Кафе и рестораны')).querySelector('.t2')!.textContent).toBe('2 записи')
  })

  it('deleting an income category moves its records to «Прочий доход»', async () => {
    const t = await spend('Зарплата')
    renderCats()
    await act2('Зарплата', 'Удалить')
    expect(await screen.findByText('Категория удалена, записи — в «Прочий доход»')).toBeTruthy()
    expect((await env.db.transactions.get(t.id))!.category_id).toBe(cat['Прочий доход'].id)
  })
})

describe('Категории: «Новая категория»', () => {
  async function openForm() {
    renderCats()
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }))
    expect(await screen.findByText('Новая категория')).toBeTruthy()
  }

  it('creates «Спорт» (capitalised) as an expense with the chosen colour and glyph; «Добавить» hides meanwhile', async () => {
    await openForm()
    expect(screen.queryByRole('button', { name: 'Добавить' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Цвет: / })).toHaveLength(10)
    expect(screen.getAllByRole('button', { name: /^Значок: / })).toHaveLength(18)

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: '  спорт ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Цвет: Красный' }))
    fireEvent.click(screen.getByRole('button', { name: 'Значок: Спорт' }))
    expect(screen.getByRole('button', { name: 'Цвет: Красный' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))

    await waitFor(async () => {
      const made = (await env.db.categories.toArray()).find((c) => c.name === 'Спорт')
      expect(made).toMatchObject({ kind: 'expense', color: '#FF3B30', glyph: 'gym', archived: false, keywords: [], deleted_at: null })
    })
    expect(await rowOf('Спорт')).toBeTruthy()
    expect(await screen.findByText('Категория «Спорт» добавлена')).toBeTruthy()
    expect(screen.queryByText('Новая категория')).toBeNull()
    expect(screen.getByRole('button', { name: 'Добавить' })).toBeTruthy()
  })

  it('«Доход» makes an income category', async () => {
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Доход' }))
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Фриланс' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    await waitFor(async () =>
      expect((await env.db.categories.toArray()).find((c) => c.name === 'Фриланс')).toMatchObject({ kind: 'income' }),
    )
  })

  it('the name is at most 30 characters', async () => {
    await openForm()
    expect((screen.getByLabelText('Название') as HTMLInputElement).maxLength).toBe(30)
  })

  it('a repeated name is refused without regard to case; an archived one says to bring it back', async () => {
    await env.repo.put<Category>('categories', { id: cat['Одежда'].id, archived: true })
    await openForm()
    const count = (await env.db.categories.toArray()).length

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'кафе И рестораны' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Такая категория уже есть')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'ОДЕЖДА' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Такая категория есть в архиве — верни её оттуда')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Впиши название')).toBeTruthy()

    await act(async () => {})
    expect((await env.db.categories.toArray()).length).toBe(count)
  })

  it('«Отмена» closes the card without writing', async () => {
    await openForm()
    const count = (await env.db.categories.toArray()).length
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Спорт' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByText('Новая категория')).toBeNull())
    expect((await env.db.categories.toArray()).length).toBe(count)
  })
})

describe('Категории: «Изменить»', () => {
  it('the swipe has «Изменить», «В архив», «Удалить»; «Изменить» opens «Категория» prefilled, and a rename saves', async () => {
    renderCats()
    const row = await rowOf('Одежда')
    fireEvent.keyDown(row.querySelector('.tx')!, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect([...row.querySelectorAll('.act')].map((b) => b.textContent)).toEqual(['Изменить', 'В архив', 'Удалить']),
    )
    fireEvent.click(within(row).getByRole('button', { name: 'Изменить' }))

    expect(await screen.findByText('Категория')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Добавить' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Тип' })).toBeNull()
    const input = screen.getByLabelText('Название') as HTMLInputElement
    expect(input.value).toBe('Одежда')
    // the built-in style is preselected: #5856D6 is not among the 10, so no swatch; the shirt glyph is
    expect(screen.getByRole('button', { name: 'Значок: Одежда' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(input, { target: { value: 'одежда и обувь' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(async () => expect((await env.db.categories.get(cat['Одежда'].id))!.name).toBe('Одежда и обувь'))
    const saved = (await env.db.categories.get(cat['Одежда'].id))!
    // only the name changed: colour and glyph stay built-in (null)
    expect(saved).toMatchObject({ color: null, glyph: null, kind: 'expense' })
    await waitFor(() => expect(screen.queryByText('Категория')).toBeNull())
    expect(await rowOf('Одежда и обувь')).toBeTruthy()
  })

  it('colour and glyph changes are saved; the same name in another case is not a repeat of itself', async () => {
    renderCats()
    await act2('Подарки', 'Изменить')
    await screen.findByText('Категория')
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'подарки' } })
    fireEvent.click(screen.getByRole('button', { name: 'Цвет: Жёлтый' }))
    fireEvent.click(screen.getByRole('button', { name: 'Значок: Книга' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(async () =>
      expect(await env.db.categories.get(cat['Подарки'].id)).toMatchObject({ name: 'Подарки', color: '#FFCC00', glyph: 'book', icon: '📚' }),
    )
  })

  it('renaming to another category’s name is refused', async () => {
    renderCats()
    await act2('Подарки', 'Изменить')
    await screen.findByText('Категория')
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'ПРОДУКТЫ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Такая категория уже есть')).toBeTruthy()
    expect((await env.db.categories.get(cat['Подарки'].id))!.name).toBe('Подарки')
  })
})

describe('Категории: edge cases', () => {
  it('a category in the bin still blocks its name (it may come back with «Отменить»); the new one sorts after it', async () => {
    renderCats()
    await act2('Подарки', 'Удалить')
    await screen.findByText('Категория удалена, записи — в «Прочее»')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
    fireEvent.change(await screen.findByLabelText('Название'), { target: { value: 'подарки' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    expect(await screen.findByText('Такая категория уже есть')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Спорт' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    await waitFor(async () => expect((await env.db.categories.toArray()).some((c) => c.name === 'Спорт')).toBe(true))
    const all = await env.db.categories.toArray()
    expect(new Set(all.map((c) => c.sort)).size).toBe(all.length)
  })

  it('a refused delete says why and moves nothing', async () => {
    const t = await spend('Кафе и рестораны')
    vi.spyOn(env.repo, 'removeCategory').mockResolvedValue(null)
    renderCats()
    await act2('Кафе и рестораны', 'Удалить')
    expect(await screen.findByText('Категория уже удалена')).toBeTruthy()
    expect((await env.db.transactions.get(t.id))!.category_id).toBe(cat['Кафе и рестораны'].id)
  })

  it('tapping «Прочее» while a row is open only closes that row', async () => {
    renderCats()
    const row = await rowOf('Продукты')
    fireEvent.keyDown(row.querySelector('.tx')!, { key: 'ArrowLeft' })
    await waitFor(() => expect(row.classList.contains('swiping')).toBe(true))
    fireEvent.click((await rowOf('Прочее')).querySelector('.tx')!)
    await waitFor(() => expect(row.classList.contains('swiping')).toBe(false))
    expect(screen.queryByText(/^Расходы .* cats$/)).toBeNull()
  })
})
