import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { Settings } from '@shared/types.ts'
import { Shell } from '../Shell.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import { applyLayout, type Layout } from './layout.ts'

/** The signed-in app on the PC layout: one account with $100, optional settings, an optional record of today. */
export async function deskShell(layout: Layout = 'full', settings: Partial<Settings> = {}, withTx = false) {
  const env = makeEnv()
  await env.repo.initDefaults('single', [{ currency: 'USD', amount: 100 }])
  const s = (await env.db.settings.toCollection().first())!
  if (Object.keys(settings).length) await env.repo.put<Settings>('settings', { id: s.id, ...settings })
  const account = (await env.db.accounts.toCollection().first())!
  const tx = withTx
    ? await env.repo.addTransaction({
        kind: 'expense',
        amount: 12,
        currency: 'USD',
        account_id: account.id,
        to_account_id: null,
        to_amount: null,
        to_currency: null,
        category_id: null,
        date: TEST_TODAY,
        note: 'кофе',
        source: 'app',
      })
    : null
  act(() => applyLayout(layout))
  renderWithApp(<Shell onSignOut={vi.fn()} />, env)
  return { env, tx }
}
