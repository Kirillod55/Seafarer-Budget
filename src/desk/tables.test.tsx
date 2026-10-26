import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { alive } from '@shared/alive.ts'
import type { Category } from '@shared/types.ts'
import { deskShell } from './test-desk.tsx'

const menuItem = (name: string) => within(screen.getByRole('complementary', { name: 'Разделы' })).getByRole('button', { name })

describe('PC tables (spec §11 «Таблицы вместо телефонных списков»)', () => {
  it('Категории: two tables; a row click opens its records, «‹ Категории» goes back', async () => {
    await deskShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Категории' }))
    const tables = await screen.findAllByRole('table')
    expect(tables).toHaveLength(2)
    expect(within(tables[0]).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Категория', 'Записей', 'За месяц', 'Лимит', ''])
    const other = within(tables[0]).getByText('Прочее').closest('tr')!
    expect(within(other).queryByRole('button', { name: 'Удалить' })).toBeNull()
    const first = tables[0].querySelector<HTMLElement>('tbody tr')!
    fireEvent.keyDown(first, { key: 'Enter' })
    const back = await screen.findByRole('button', { name: 'Назад, Категории' })
    expect(menuItem('Категории').getAttribute('aria-current')).toBe('page')
    fireEvent.click(back)
    expect(await screen.findAllByRole('table')).toHaveLength(2)
  })

  it('Категории: «В архив» on a row with «Отменить»', async () => {
    const { env } = await deskShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Категории' }))
    const table = (await screen.findAllByRole('table'))[0]
    const row = table.querySelectorAll<HTMLElement>('tbody tr')[0]
    const name = row.querySelector('.cname')!.textContent!
    fireEvent.click(within(row).getByRole('button', { name: 'В архив' }))
    expect(await screen.findByText('Категория в архиве')).toBeTruthy()
    await waitFor(async () => expect((await env.db.categories.filter((c: Category) => c.name === name).first())!.archived).toBe(true))
  })

  it('Архив: one table with type column; «Удалить» asks on a line under the row', async () => {
    const { env } = await deskShell()
    const c = (await env.db.categories.filter((x) => x.kind === 'expense' && x.name !== 'Прочее').first())!
    await env.repo.put<Category>('categories', { id: c.id, archived: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Архив' }))
    const table = await screen.findByRole('table')
    const row = within(table).getByText(c.name).closest('tr')!
    expect(within(row).getByText('Категория')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
    const conf = table.querySelector<HTMLElement>('tr.confrow')!
    expect(conf.textContent).toContain(`Удалить «${c.name}»?`)
    fireEvent.click(within(conf).getByRole('button', { name: 'Удалить' }))
    await waitFor(async () => expect((await env.db.categories.get(c.id))!.deleted_at).not.toBeNull())
  })

  it('Лимиты: a table with spent, limit, left, status and «Убрать»', async () => {
    const { env } = await deskShell()
    const c = (await env.db.categories.filter((x) => x.kind === 'expense').first())!
    await env.repo.put('limits', { id: 'l1', deleted: false, category_id: c.id, monthly_usd: 50, deleted_at: null, deleted_batch: null })
    fireEvent.click(await screen.findByRole('button', { name: 'Лимиты' }))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Категория', 'Потрачено', 'Лимит', 'Осталось', '', 'Статус', ''])
    expect(within(table).getByText('В норме')).toBeTruthy()
    fireEvent.click(within(table).getByRole('button', { name: `Убрать лимит «${c.name}»` }))
    expect(await screen.findByText('Лимит убран')).toBeTruthy()
    await waitFor(async () => expect(await env.db.limits.filter(alive).count()).toBe(0))
  })
})
