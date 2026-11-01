import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../../runtime.ts', () => ({ isTauri: () => true, tauriInvoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('../../desk/layout.ts', async (real) => ({ ...(await real<object>()), useDesk: () => true }))

const pressed = () => screen.queryAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent

describe('«Значок в трее»', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
  })

  it('the switch first appears where the program has it: «Выкл» never starts from «Вкл»', async () => {
    let answer = (_: boolean) => {}
    invoke.mockReturnValue(new Promise((r) => (answer = r)))
    const { TrayRow } = await import('./TrayRow.tsx')
    render(<TrayRow />)
    expect(screen.queryByRole('group', { name: 'Значок в трее' })).toBeNull()
    answer(false)
    await waitFor(() => expect(pressed()).toBe('Выкл'))
  })

  it('a later visit has it at once', async () => {
    invoke.mockResolvedValue(false)
    const { TrayRow } = await import('./TrayRow.tsx')
    const first = render(<TrayRow />)
    await waitFor(() => expect(pressed()).toBe('Выкл'))
    first.unmount()
    render(<TrayRow />)
    expect(pressed()).toBe('Выкл')
  })
})
