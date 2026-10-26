import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateToast } from './UpdateToast.tsx'
import { FAILED_TEXT, createUpdater, type UpdateInfo } from './updater.ts'

const info = (install: UpdateInfo['install'] = async () => {}): UpdateInfo => ({ version: '1.2.0', notes: 'Новое', install })

describe('Windows auto-update (spec §11 «Автообновление»)', () => {
  it('offline: the check is skipped silently', async () => {
    const check = vi.fn(async () => info())
    const u = createUpdater({ check, online: () => false })
    expect(await u.checkNow()).toBeNull()
    expect(check).not.toHaveBeenCalled()
    expect(u.get().phase).toBe('idle')
  })

  it('a failing check stays silent', async () => {
    const u = createUpdater({ check: async () => Promise.reject(new Error('offline')), online: () => true })
    expect(await u.checkNow()).toBeNull()
    expect(u.get().phase).toBe('idle')
  })

  it('a newer version shows the notification; «Позже» hides it until the next start', async () => {
    const u = createUpdater({ check: async () => info(), online: () => true })
    render(<UpdateToast updater={u} />)
    await act(() => u.checkNow())
    expect(screen.getByText('Доступна версия 1.2.0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Что нового' }))
    expect(screen.getByText('Новое')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))
    expect(screen.queryByText('Доступна версия 1.2.0')).toBeNull()
    await act(() => u.checkNow())
    expect(screen.queryByText('Доступна версия 1.2.0')).toBeNull()
  })

  it('install shows the progress; a failure says «попробую позже»', async () => {
    let report: (p: number | null) => void = () => {}
    let fail: (e: Error) => void = () => {}
    const install = (onProgress: (p: number | null) => void) =>
      new Promise<void>((_, reject) => {
        report = onProgress
        fail = reject
      })
    const u = createUpdater({ check: async () => info(install), online: () => true })
    render(<UpdateToast updater={u} />)
    await act(() => u.checkNow())
    fireEvent.click(screen.getByRole('button', { name: 'Обновить и перезапустить' }))
    act(() => report(0.5))
    expect((screen.getByLabelText('Загрузка обновления') as HTMLProgressElement).value).toBe(0.5)
    await act(async () => fail(new Error('net')))
    expect(screen.getByText(FAILED_TEXT)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    // the next check may offer it again
    await act(() => u.checkNow())
    expect(screen.getByText('Доступна версия 1.2.0')).toBeTruthy()
  })

  it('start checks at once and every 6 hours', () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => null)
    const stop = createUpdater({ check, online: () => true }).start()
    expect(check).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(check).toHaveBeenCalledTimes(2)
    stop()
    vi.useRealTimers()
  })
})
