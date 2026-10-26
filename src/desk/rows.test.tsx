import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { alive } from '@shared/alive.ts'
import { TEST_TODAY } from '../test-utils.tsx'
import { deskShell } from './test-desk.tsx'

const row = async () => (await screen.findByRole('button', { name: /кофе/i })).closest<HTMLElement>('[data-swipe-row]')!

describe('PC rows: hover buttons and the right-click menu (spec §11 «Мышь и клавиатура»)', () => {
  it('hover buttons «Изменить · В архив · Удалить»; delete has «Отменить»', async () => {
    const { env, tx } = await deskShell('full', {}, true)
    const r = await row()
    const hov = r.querySelector<HTMLElement>('.hov')!
    expect([...hov.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Изменить', 'В архив', 'Удалить'])
    // no swipe buttons are reachable on the PC
    expect(r.querySelector('.acts')!.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(within(hov).getByRole('button', { name: 'Удалить' }))
    expect(await screen.findByText('Запись удалена')).toBeTruthy()
    await waitFor(async () => expect((await env.db.transactions.get(tx!.id))!.deleted_at).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.transactions.get(tx!.id))!.deleted_at).toBeNull())
  })

  it('hover «Изменить» opens the record', async () => {
    await deskShell('full', {}, true)
    fireEvent.click(within((await row()).querySelector<HTMLElement>('.hov')!).getByRole('button', { name: 'Изменить' }))
    // the record window reads all records first: slow under a full parallel run
    expect(await screen.findByRole('dialog', { name: 'Запись' }, { timeout: 8000 })).toBeTruthy()
  })

  it('right click: «Изменить, В архив, Дублировать на сегодня, Удалить»; the copy has «Отменить»', async () => {
    const { env } = await deskShell('full', {}, true)
    fireEvent.contextMenu((await row()).querySelector('.tx')!, { clientX: 100, clientY: 100 })
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Изменить', 'В архив', 'Дублировать на сегодня', 'Удалить'])
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Дублировать на сегодня' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(await screen.findByText('Копия на сегодня')).toBeTruthy()
    await waitFor(async () => expect((await env.db.transactions.filter(alive).toArray()).filter((t) => t.note === 'кофе')).toHaveLength(2))
    const copies = (await env.db.transactions.filter(alive).toArray()).filter((t) => t.note === 'кофе')
    expect(copies.every((t) => t.date === TEST_TODAY && t.amount === 12)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(async () => expect((await env.db.transactions.filter(alive).toArray()).filter((t) => t.note === 'кофе' && !t.deleted_at)).toHaveLength(1))
  })

  it('the menu: ↓ ↑ go round, Esc and a click elsewhere close it', async () => {
    await deskShell('full', {}, true)
    const tx = (await row()).querySelector<HTMLElement>('.tx')!
    tx.focus()
    fireEvent.contextMenu(tx, { clientX: 10, clientY: 10 })
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(items[3], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tx)
    fireEvent.contextMenu(tx, { clientX: 10, clientY: 10 })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the phone has no hover buttons and no menu', async () => {
    await deskShell('phone', {}, true)
    const r = await row()
    expect(r.querySelector('.hov')).toBeNull()
    fireEvent.contextMenu(r.querySelector('.tx')!)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
