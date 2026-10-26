import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/types.ts'
import { applyLayout } from './layout.ts'
import { deskShell } from './test-desk.tsx'
import { activeItem } from './Sidebar.tsx'

const menu = () => screen.getByRole('complementary', { name: 'Разделы' })
const item = (name: string) => within(menu()).getByRole('button', { name })

describe('PC menu (spec §11 «Меню слева»)', () => {
  it('replaces the tabs: seven sections, a divider and «Настройки»', async () => {
    await deskShell()
    await screen.findByRole('button', { name: 'Новая запись' })
    expect(document.querySelector('nav.tabs')).toBeNull()
    const names = [...menu().querySelectorAll('.si')].map((b) => b.textContent)
    expect(names).toEqual(['Главная', 'Отчёт', 'Цели', 'Лимиты', 'Счета', 'Категории', 'Архив', 'Настройки'])
    expect(item('Главная').getAttribute('aria-current')).toBe('page')
  })

  it('items open their screens; the deeper ones without «‹ Ещё»', async () => {
    await deskShell()
    fireEvent.click(item('Категории'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Категории' })).toBeTruthy()
    expect(item('Категории').getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Назад, Ещё' })).toBeNull()
    fireEvent.click(item('Настройки'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Настройки' })).toBeTruthy()
    // one stack entry at a time: the categories screen is gone, not hidden under the settings
    expect(document.querySelectorAll('section.screen')).toHaveLength(1)
    expect(document.querySelector('section.screen')!.className).toContain('v-desk')
  })

  it('page header: the calendar shows the path «Главная › …», which goes back', async () => {
    await deskShell()
    fireEvent.click(await screen.findByRole('button', { name: /Сегодня/ }))
    const crumb = await screen.findByRole('button', { name: 'Назад, Главная' })
    expect(crumb.className).toBe('crumb')
    expect(document.querySelector('.navbar')).toBeNull()
    expect(item('Главная').getAttribute('aria-current')).toBe('page')
    fireEvent.click(crumb)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Назад, Главная' })).toBeNull())
  })

  it('the calendar keeps «Главная» lit; «Расходы» light where they came from', () => {
    expect(activeItem({ tab: 'home', screen: 'calendar' })).toBe('home')
    expect(activeItem({ tab: 'more', screen: 'records', month: '2026-10', category: null, from: 'cats' })).toBe('cats')
    expect(activeItem({ tab: 'report', screen: 'records', month: '2026-10', category: null, from: 'report' })).toBe('report')
    expect(activeItem({ tab: 'more', screen: 'root' })).toBe('settings')
  })

  it('partner status: red «не подключена к боту» until she wrote /start, green after', async () => {
    const { env } = await deskShell('full', { partner_name: 'Маша' })
    const off = await within(menu()).findByRole('button', { name: 'Маша не подключена к боту' })
    expect(off.className).toContain('off')
    const s = (await env.db.settings.toCollection().first())!
    await act(() => env.repo.put<Settings>('settings', { id: s.id, partner_seen_at: '2026-10-20T10:00:00Z' }))
    const on = await within(menu()).findByRole('button', { name: 'Маша подключена к боту' })
    expect(on.className).not.toContain('off')
    fireEvent.click(on)
    expect(await screen.findByRole('heading', { level: 1, name: 'Настройки' })).toBeTruthy()
  })

  it('resizing below 1024 px brings the tabs back', async () => {
    await deskShell('icons')
    await screen.findByRole('button', { name: 'Новая запись' })
    act(() => applyLayout('phone'))
    await waitFor(() => expect(document.querySelector('nav.tabs')).toBeTruthy())
    expect(screen.queryByRole('complementary', { name: 'Разделы' })).toBeNull()
  })
})
