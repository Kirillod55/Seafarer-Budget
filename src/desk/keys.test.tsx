import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { alive } from '@shared/alive.ts'
import { deskShell } from './test-desk.tsx'

const key = (code: string, k = code, target: Element = document.body) => fireEvent.keyDown(target, { code, key: k })
const dialogGone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

describe('PC keys (spec §11 «Клавиши», «Фокус не теряется»)', () => {
  it('N opens a new record again and again: after «Отмена», after Esc', async () => {
    await deskShell()
    await screen.findByRole('button', { name: /Новая запись/ })
    key('KeyN', 'n')
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Сумма')))
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await dialogGone()
    key('KeyN', 'т') // the Russian layout: same key
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Сумма')))
    fireEvent.keyDown(screen.getByLabelText('Сумма'), { key: 'Escape' })
    await dialogGone()
    expect(document.activeElement?.classList.contains('addbtn')).toBe(true)
    key('KeyN', 'n', document.activeElement!)
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
  })

  it('N → 45 → Enter saves; focus goes to «Новая запись»; N again', async () => {
    const { env } = await deskShell()
    await screen.findByRole('button', { name: /Новая запись/ })
    key('KeyN', 'n')
    const amount = await screen.findByLabelText('Сумма')
    fireEvent.change(amount, { target: { value: '45' } })
    fireEvent.keyDown(amount, { key: 'Enter' })
    await dialogGone()
    await waitFor(async () => expect((await env.db.transactions.filter(alive).toArray()).some((t) => t.amount === 45)).toBe(true))
    expect(document.activeElement?.classList.contains('addbtn')).toBe(true)
    key('KeyN', 'n', document.activeElement!)
    expect(await screen.findByRole('dialog', { name: 'Новая запись' })).toBeTruthy()
  })

  it('keys do nothing while typing in a field', async () => {
    await deskShell()
    const quick = await screen.findByLabelText('Быстрая запись')
    quick.focus()
    key('KeyN', 'n', quick)
    key('Slash', '/', quick)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('↑ ↓ move through the records, Delete removes the focused one with «Отменить»', async () => {
    const { env, tx } = await deskShell('full', {}, true)
    await screen.findByRole('button', { name: /кофе/i })
    key('ArrowDown')
    const first = document.activeElement as HTMLElement
    expect(first.classList.contains('tx')).toBe(true)
    key('ArrowUp', 'ArrowUp', first)
    expect(document.activeElement).toBe(first) // stays on the first one
    const coffee = screen.getByRole('button', { name: /кофе/i })
    coffee.focus()
    key('Delete', 'Delete', coffee)
    expect(await screen.findByText('Запись удалена')).toBeTruthy()
    await waitFor(async () => expect((await env.db.transactions.get(tx!.id))!.deleted_at).not.toBeNull())
  })

  it('/ from another section goes to «Главная» and puts the cursor in the quick input', async () => {
    await deskShell()
    fireEvent.click(within(await screen.findByRole('complementary', { name: 'Разделы' })).getByRole('button', { name: 'Цели' }))
    await screen.findByRole('heading', { level: 1, name: 'Цели' })
    key('Slash', '/')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Быстрая запись')))
  })

  it('the page does not react while the record window is open', async () => {
    await deskShell('full', {}, true)
    await screen.findByRole('button', { name: /кофе/i })
    key('KeyN', 'n')
    await screen.findByRole('dialog', { name: 'Новая запись' })
    key('ArrowDown')
    expect((document.activeElement as HTMLElement).classList.contains('tx')).toBe(false)
  })
})
