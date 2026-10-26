import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deskShell } from './test-desk.tsx'

describe('PC «Настройки» (spec §11 «Меню слева», «Настройки — как Параметры»)', () => {
  it('is titled «Настройки», without the links that are in the menu, with «О программе» and the version', async () => {
    await deskShell()
    fireEvent.click(within(await screen.findByRole('complementary', { name: 'Разделы' })).getByRole('button', { name: 'Настройки' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Настройки' })).toBeTruthy()
    expect(document.querySelector('.screen .menu')).toBeNull()
    const about = await screen.findByRole('region', { name: 'О программе' })
    expect(within(about).getByText(`Seafarer Budget ${__APP_VERSION__}`)).toBeTruthy()
    // outside the Windows app there is nothing to update by hand
    expect(within(about).queryByRole('button', { name: 'Проверить обновления' })).toBeNull()
  })

  it('Windows Settings groups of rows as in prototype v60; a row control saves its own field', async () => {
    const { env } = await deskShell()
    fireEvent.click(within(await screen.findByRole('complementary', { name: 'Разделы' })).getByRole('button', { name: 'Настройки' }))
    await screen.findByRole('heading', { level: 1, name: 'Настройки' })
    const groups = await screen.findAllByRole('heading', { level: 2 })
    expect(groups.map((h) => h.textContent)).toEqual(['Бюджет до посадки', 'Оформление и счета', 'Валюты', 'Telegram-бот', 'Данные', 'О программе'])
    expect(document.querySelector('.screen .mcard')).toBeNull()
    expect(document.querySelector('.srow.calcrow')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Дата посадки'), { target: { value: '2026-12-20' } })
    await waitFor(async () => expect((await env.db.settings.toCollection().first())!.next_contract_date).toBe('2026-12-20'))
    const data = screen.getByRole('region', { name: 'Данные' })
    expect(within(data).getByText('Выйти из аккаунта')).toBeTruthy()
    const del = within(data).getAllByRole('button', { name: 'Удалить…' })
    expect(del).toHaveLength(2)
    fireEvent.click(del[0])
    expect(await within(data).findByRole('group', { name: 'Удалить записи' })).toBeTruthy()
    expect(del[0].getAttribute('aria-expanded')).toBe('true')
  })

  it('the phone «Ещё» keeps its menu and has no «О программе»', async () => {
    await deskShell('phone')
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Ещё' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'О программе' })).toBeNull()
  })
})
