import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Settings as SettingsRow } from '@shared/types.ts'
import { LegacyAccounts } from './LegacyManage.tsx'
import { makeEnv, renderWithApp } from '../test-utils.tsx'
import type { AppContextValue } from '../context.tsx'

// The 1.0 accounts management, kept until Task 14 replaces it (moved from Settings.test.tsx).

let env: AppContextValue
let main: Account

async function seed(mode: 'single' | 'multi' = 'single') {
  await env.repo.initDefaults(mode, [{ currency: 'UAH', amount: 5000 }])
  main = (await env.db.accounts.toCollection().first())!
}

const settingsRow = async () => (await env.db.settings.toCollection().first())!
const renderAccounts = () => renderWithApp(<LegacyAccounts />, env)
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  env = makeEnv()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Legacy: accounts', () => {
  it('account management is shown in multi mode only', async () => {
    await seed('single')
    const view = renderAccounts()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('region', { name: 'Управление счетами' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Изменить счёт Основной' })).toBeNull()

    view.unmount()
    await env.repo.put<SettingsRow>('settings', { id: (await settingsRow()).id, accounts_mode: 'multi' })
    renderAccounts()
    expect(await screen.findByRole('region', { name: 'Управление счетами' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Изменить счёт Основной' })).toBeTruthy()
  })

  it('renames an account and stores its aliases', async () => {
    await seed('multi')
    renderAccounts()

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить счёт Основной' }))
    fireEvent.change(screen.getByLabelText('Название счёта'), { target: { value: 'Моно' } })
    fireEvent.change(screen.getByLabelText('Псевдонимы (через запятую)'), { target: { value: 'карта, mono , ' } })
    click('Сохранить счёт')

    await waitFor(async () =>
      expect(await env.db.accounts.get(main.id)).toMatchObject({ name: 'Моно', aliases: ['карта', 'mono'], dirty: 1 }),
    )
  })

  it('the default account cannot be archived; another can, and is restorable', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    renderAccounts()

    const defaultBtn = (await screen.findByRole('button', { name: 'Архивировать счёт Основной' })) as HTMLButtonElement
    expect(defaultBtn.disabled).toBe(true)

    click('Архивировать счёт Наличные')
    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(true))
    expect((await env.db.accounts.get(main.id))!.archived).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть счёт Наличные' }))
    await waitFor(async () => expect((await env.db.accounts.get(cash.id))!.archived).toBe(false))
  })

  it('the last remaining account cannot be archived even if it is not marked default', async () => {
    await seed('multi')
    const cash = await env.repo.put<Account>('accounts', { name: 'Наличные', aliases: [], is_default: false, archived: false, sort: 1 })
    await env.repo.put<Account>('accounts', { ...main, archived: true, is_default: false })
    renderAccounts()

    const btn = (await screen.findByRole('button', { name: 'Архивировать счёт Наличные' })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect((await env.db.accounts.get(cash.id))!.archived).toBe(false)
  })
})
