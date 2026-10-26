import { fireEvent, screen, within } from '@testing-library/react'
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

  it('the phone «Ещё» keeps its menu and has no «О программе»', async () => {
    await deskShell('phone')
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Ещё' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'О программе' })).toBeNull()
  })
})
