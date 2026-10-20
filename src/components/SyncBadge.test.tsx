import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@shared/types.ts'
import type { SchedulerStatus } from '../db/scheduler.ts'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import { SyncBadge } from './SyncBadge.tsx'

function envWith(status: SchedulerStatus) {
  const env = makeEnv()
  env.scheduler = { kick: vi.fn(), stop: vi.fn(), status$: { get: () => status, subscribe: () => () => {} } }
  return env
}

const idle: SchedulerStatus = { state: 'idle', lastSyncAt: 1, error: null }

describe('SyncBadge (I1)', () => {
  it('shows the server error text on the badge itself', async () => {
    const env = envWith({ state: 'error', lastSyncAt: null, error: 'permission denied for table accounts' })
    renderWithApp(<SyncBadge />, env)
    expect((await screen.findByRole('status')).textContent).toBe('ошибка: permission denied for table accounts')
  })

  it('a network failure still reads «офлайн»', async () => {
    const env = envWith({ state: 'error', lastSyncAt: null, error: 'TypeError: Failed to fetch' })
    renderWithApp(<SyncBadge />, env)
    expect((await screen.findByRole('status')).textContent).toBe('офлайн')
  })

  it('a parked row shows its error even after a clean sync', async () => {
    const env = envWith(idle)
    const row = await env.repo.put<Account>('accounts', { name: 'X', aliases: [], is_default: false, archived: false, sort: 0 })
    await env.db.accounts.update(row.id, { dirty: 2 })
    await env.db.meta.put({ key: `parked:accounts:${row.id}`, value: { table: 'accounts', id: row.id, error: 'value too long' } })
    renderWithApp(<SyncBadge />, env)
    expect(await screen.findByText('ошибка: value too long')).toBeTruthy()
  })

  it('a clean idle sync is «синхронизировано»', async () => {
    renderWithApp(<SyncBadge />, envWith(idle))
    expect(await screen.findByText('✓ синхронизировано')).toBeTruthy()
  })
})
