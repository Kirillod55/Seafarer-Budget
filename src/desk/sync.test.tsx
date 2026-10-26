import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deskShell } from './test-desk.tsx'

describe('PC sync cloud is a button with a flyout (spec §11 «Облачко синхронизации — кнопка»)', () => {
  it('opens the flyout, syncs now with a toast, closes on Esc with focus back on the cloud', async () => {
    const { env } = await deskShell()
    const cloud = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('.home-top button.syncind')
      if (!b) throw new Error('no cloud button yet')
      return b
    })
    expect(cloud.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(cloud)
    const fly = screen.getByRole('dialog', { name: 'Синхронизация' })
    expect(cloud.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(fly).getByRole('button', { name: 'Синхронизировать сейчас' }))
    await waitFor(() => expect(env.scheduler.syncNow).toHaveBeenCalled())
    expect(await screen.findByText('Синхронизировано')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Синхронизация' })).toBeNull()
    expect(document.activeElement).toBe(cloud)
  })

  it('a second click and a click elsewhere close it', async () => {
    await deskShell()
    const cloud = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('.home-top button.syncind')
      if (!b) throw new Error('no cloud button yet')
      return b
    })
    fireEvent.click(cloud)
    fireEvent.click(cloud)
    expect(screen.queryByRole('dialog', { name: 'Синхронизация' })).toBeNull()
    fireEvent.click(cloud)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Синхронизация' })).toBeNull()
  })

  it('the phone keeps the plain indicator', async () => {
    await deskShell('phone')
    await waitFor(() => expect(document.querySelector('.home-top .syncind[role="img"]')).toBeTruthy())
    expect(document.querySelector('.home-top button.syncind')).toBeNull()
  })
})
