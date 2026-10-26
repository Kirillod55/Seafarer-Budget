import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alive } from '@shared/alive.ts'
import type { Account, Category } from '@shared/types.ts'
import { More } from '../More.tsx'
import { Navigator, type Route } from '../../nav/Navigator.tsx'
import { ToastHost } from '../../ui/Toast.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../../test-utils.tsx'
import type { AppContextValue } from '../../context.tsx'

let env: AppContextValue
let main: Account
let cafe: Category

async function seed() {
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 5000 }])
  main = (await env.db.accounts.toCollection().first())!
  cafe = (await env.db.categories.toArray()).find((c) => c.name === 'Кафе и рестораны')!
  await env.repo.addTransaction({
    kind: 'expense',
    amount: 12.5,
    currency: 'UAH',
    account_id: main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cafe.id,
    date: TEST_TODAY,
    note: 'кофе',
    source: 'app',
    author: 'owner',
  })
}

const renderMore = () =>
  renderWithApp(
    <>
      <Navigator renderScreen={(r: Route) => (r.screen === 'root' ? <More onSignOut={vi.fn()} /> : <p>Экран {r.screen}</p>)} />
      <ToastHost />
    </>,
    env,
  )

/** Picks a file in the «Загрузить из CSV» field of «Резервная копия»; resolves to the card. */
async function pick(text: string) {
  const card = await screen.findByRole('region', { name: 'Резервная копия' })
  expect(within(card).getByRole('button', { name: 'Загрузить из CSV' })).toBeTruthy()
  const input = within(card).getByLabelText('Файл CSV') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([text], 'backup.csv', { type: 'text/csv' })] } })
  return card
}

const liveCount = async () => (await env.db.transactions.toArray()).filter(alive).length

beforeEach(() => {
  env = makeEnv()
})

describe('«Загрузить из CSV»', () => {
  it('a file with a duplicate and an unknown category: the right numbers; «Отменить» leaves nothing behind', async () => {
    await seed()
    const before = await liveCount()
    const categoriesBefore = (await env.db.categories.toArray()).filter(alive).length
    renderMore()
    const card = await pick(
      [
        'Дата;Тип;Сумма;Валюта;Категория;Заметка',
        `${TEST_TODAY};Расход;12,5;UAH;Кафе и рестораны;кофе`,
        '2026-10-20;Расход;100;UAH;Кино;',
        '2026-10-19;Доход;500;UAH;Зарплата;аванс',
      ].join('\n'),
    )
    expect(await within(card).findByText('Найдено 3 записи: 2 новые, 1 уже есть — их пропущу')).toBeTruthy()
    // the first rows of what will be loaded
    const preview = within(card).getByRole('list', { name: 'Первые записи' })
    expect(within(preview).getAllByRole('listitem')).toHaveLength(2)
    expect(preview.textContent).toContain('Кино')
    expect(within(card).getByText(/Кино/, { selector: '.iunknown' })).toBeTruthy()
    expect(within(card).getByRole('group', { name: 'Новые категории' })).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Загрузить 2 записи' }))
    const toast = (await screen.findByText('Загружено 2 записи')).closest('.toast') as HTMLElement
    expect(await liveCount()).toBe(before + 2)
    expect((await env.db.categories.toArray()).filter(alive).some((c) => c.name === 'Кино')).toBe(true)
    // the card is back to its button
    await waitFor(() => expect(within(card).queryByText(/Найдено/)).toBeNull())

    fireEvent.click(within(toast).getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect(await liveCount()).toBe(before))
    expect((await env.db.categories.toArray()).filter(alive)).toHaveLength(categoriesBefore)
  })

  it('«В «Прочее»» puts the unknown category\'s rows there instead of creating it', async () => {
    await seed()
    renderMore()
    const card = await pick(['Дата;Сумма;Категория', '2026-10-20;100;Кино'].join('\n'))
    await within(card).findByText('Найдено 1 запись: 1 новая')
    fireEvent.click(within(card).getByRole('button', { name: 'В «Прочее»' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Загрузить 1 запись' }))
    await screen.findByText('Загружено 1 запись')
    const cats = (await env.db.categories.toArray()).filter(alive)
    expect(cats.some((c) => c.name === 'Кино')).toBe(false)
    const other = cats.find((c) => c.name === 'Прочее')!
    const row = (await env.db.transactions.toArray()).find((t) => t.amount === 100)!
    expect(row.category_id).toBe(other.id)
  })

  it('a «Тип» cell «constructor» is a row error shown by its number', async () => {
    await seed()
    renderMore()
    const card = await pick(['Дата;Тип;Сумма;Валюта', '2026-10-20;constructor;5;UAH', '2026-10-20;Расход;7;UAH'].join('\n'))
    await within(card).findByText('Найдено 1 запись: 1 новая')
    expect(within(card).getByText('Строка 2: Неизвестный тип')).toBeTruthy()
  })

  it('a 1.0 file with a transfer explains «Сверка»', async () => {
    await seed()
    renderMore()
    const card = await pick(
      [
        'Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка',
        '2026-10-20;Расход;7;UAH;0,17;Продукты;Основной;',
        '2026-10-20;Перевод;100;UAH;2,4;;Основной → Карта;',
        '2026-10-19;Перевод;50;UAH;1,2;;Основной → Карта;',
      ].join('\r\n'),
    )
    await within(card).findByText('Найдено 1 запись: 1 новая')
    expect(
      within(card).getByText('Строки 3, 4: В старом файле нет второй половины перевода — сверь баланс через «Сверка»'),
    ).toBeTruthy()
  })

  it('«Отмена» closes the preview without loading anything', async () => {
    await seed()
    const before = await liveCount()
    renderMore()
    const card = await pick(['Дата;Сумма', '2026-10-20;100'].join('\n'))
    await within(card).findByText('Найдено 1 запись: 1 новая')
    fireEvent.click(within(card).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(within(card).queryByText(/Найдено/)).toBeNull())
    expect(await liveCount()).toBe(before)
  })
})
