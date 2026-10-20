import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FirstRunGate } from './FirstRunGate.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'

describe('FirstRunGate', () => {
  it('offline with no local settings: asks for internet, «Повторить» retries and then shows the wizard', async () => {
    const syncOnce = vi
      .fn()
      .mockResolvedValueOnce({ pushed: 0, pulled: 0, error: 'Failed to fetch' })
      .mockResolvedValue({ pushed: 0, pulled: 0 })
    renderWithApp(
      <FirstRunGate syncOnce={syncOnce}>
        <p>приложение</p>
      </FirstRunGate>,
      makeEnv(),
    )

    expect(await screen.findByText('Нужен интернет для первого запуска')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('button', { name: 'Один баланс' })).toBeTruthy()
    expect(syncOnce).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('приложение')).toBeNull()
  })

  it('renders the app when settings already exist', async () => {
    const env = makeEnv()
    await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 100 }])
    renderWithApp(
      <FirstRunGate syncOnce={vi.fn()}>
        <p>приложение</p>
      </FirstRunGate>,
      env,
    )
    await waitFor(() => expect(screen.getByText('приложение')).toBeTruthy())
  })
})
