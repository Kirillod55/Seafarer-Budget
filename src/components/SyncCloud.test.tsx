import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@shared/types.ts'
import type { SchedulerStatus } from '../db/scheduler.ts'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import { SyncCloud } from './SyncCloud.tsx'

/** An env whose scheduler status can be changed from the test. */
function envWith(initial: SchedulerStatus) {
  const env = makeEnv()
  let status = initial
  const listeners = new Set<() => void>()
  env.scheduler = {
    kick: vi.fn(),
    stop: vi.fn(),
    syncNow: vi.fn(async () => status),
    status$: {
      get: () => status,
      subscribe(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
  const set = (next: SchedulerStatus) =>
    act(() => {
      status = next
      for (const l of listeners) l()
    })
  return { env, set }
}

const idle: SchedulerStatus = { state: 'idle', lastSyncAt: 1, error: null }
const cloud = () => document.querySelector('.syncind') as HTMLElement

afterEach(() => vi.restoreAllMocks())

describe('SyncCloud — an indicator, not a button', () => {
  it('synced: the cloud with a tick in --accent-text («Синхронизировано»)', async () => {
    renderWithApp(<SyncCloud />, envWith(idle).env)
    const el = await screen.findByRole('img', { name: 'Синхронизировано' })
    expect(el.dataset.state).toBe('ok')
    expect(el.tagName).not.toBe('BUTTON')
    expect(el.getAttribute('tabindex')).toBeNull()
  })

  it('a server error: the cloud with a red cross, the error in the label', async () => {
    renderWithApp(<SyncCloud />, envWith({ state: 'error', lastSyncAt: null, error: 'permission denied for table accounts' }).env)
    const el = await screen.findByRole('img', { name: 'Синхронизация не удалась: permission denied for table accounts' })
    expect(el.dataset.state).toBe('err')
    expect(el.className).toContain('err')
  })

  it('a parked row is an error even after a clean sync', async () => {
    const { env } = envWith(idle)
    const row = await env.repo.put<Account>('accounts', { name: 'X', aliases: [], is_default: false, archived: false, sort: 0 })
    await env.db.accounts.update(row.id, { dirty: 2 })
    await env.db.meta.put({ key: `parked:accounts:${row.id}`, value: { table: 'accounts', id: row.id, error: 'value too long' } })
    renderWithApp(<SyncCloud />, env)
    await waitFor(() => expect(cloud().dataset.state).toBe('err'))
    expect(cloud().getAttribute('aria-label')).toBe('Синхронизация не удалась: value too long')
  })

  it('records waiting to be sent: the grey cloud with an arrow up', async () => {
    const { env } = envWith(idle)
    await env.repo.put<Account>('accounts', { name: 'X', aliases: [], is_default: false, archived: false, sort: 0 })
    renderWithApp(<SyncCloud />, env)
    await waitFor(() => expect(cloud().dataset.state).toBe('off'))
    expect(cloud().getAttribute('aria-label')).toBe('Ждёт отправки: 1')
  })

  it('no network (or a network failure): the grey cloud with an arrow up', async () => {
    renderWithApp(<SyncCloud />, envWith({ state: 'error', lastSyncAt: null, error: 'TypeError: Failed to fetch' }).env)
    await waitFor(() => expect(cloud().dataset.state).toBe('off'))
    expect(cloud().getAttribute('aria-label')).toBe('Нет сети')
  })

  it('going offline turns a synced cloud grey', async () => {
    renderWithApp(<SyncCloud />, envWith(idle).env)
    await waitFor(() => expect(cloud().dataset.state).toBe('ok'))
    act(() => void window.dispatchEvent(new Event('offline')))
    expect(cloud().dataset.state).toBe('off')
    act(() => void window.dispatchEvent(new Event('online')))
    expect(cloud().dataset.state).toBe('ok')
  })

  it('while syncing the two arrows spin; afterwards the tick pops in', async () => {
    const { env, set } = envWith(idle)
    renderWithApp(<SyncCloud />, env)
    await waitFor(() => expect(cloud().dataset.state).toBe('ok'))
    expect(cloud().className).not.toContain('pop')

    set({ state: 'syncing', lastSyncAt: 1, error: null })
    expect(cloud().dataset.state).toBe('sync')
    expect(cloud().className).toContain('syncing')
    expect(cloud().getAttribute('aria-label')).toBe('Синхронизация…')

    set({ state: 'idle', lastSyncAt: 2, error: null })
    expect(cloud().dataset.state).toBe('ok')
    expect(cloud().className).not.toContain('syncing')
    expect(cloud().className).toContain('pop')
  })
})
