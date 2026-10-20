import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATEGORIES } from '@shared/defaults.ts'
import { QuickInput } from './QuickInput.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'

async function setup() {
  const env = makeEnv()
  await env.repo.initDefaults('single', [{ currency: 'UAH', amount: 5000 }])
  const addTransaction = vi.spyOn(env.repo, 'addTransaction')
  renderWithApp(<QuickInput />, env)
  const input = screen.getByLabelText('Быстрая запись') as HTMLInputElement
  const submit = (text: string) => {
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(input.closest('form')!)
  }
  return { env, input, submit, addTransaction }
}

describe('QuickInput', () => {
  it('«такси 15 eur» + Enter → EUR expense in «Транспорт и такси», field cleared', async () => {
    const { env, input, submit, addTransaction } = await setup()
    const transport = (await env.db.categories.toArray()).find((c) => c.name === 'Транспорт и такси')!
    expect(transport).toBeTruthy()
    expect(DEFAULT_CATEGORIES.some((c) => c.name === 'Транспорт и такси')).toBe(true)

    submit('такси 15 eur')

    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1))
    expect(addTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'expense',
        amount: 15,
        currency: 'EUR',
        category_id: transport.id,
        date: TEST_TODAY,
        source: 'app',
      }),
    )
    await waitFor(() => expect(input.value).toBe(''))
    expect(await env.db.transactions.count()).toBe(2) // opening balance + the new one
  })

  it('«кофе» without an amount → hint with an example, nothing is saved', async () => {
    const { input, submit, addTransaction } = await setup()

    submit('кофе')

    expect(await screen.findByText(/кофе 80/)).toBeTruthy()
    expect(addTransaction).not.toHaveBeenCalled()
    expect(input.value).toBe('кофе') // the text stays so it can be fixed
  })

  it('puts the expense on the default account', async () => {
    const { env, submit, addTransaction } = await setup()
    submit('кофе 80')
    await waitFor(() => expect(addTransaction).toHaveBeenCalled())
    const main = (await env.db.accounts.toArray()).find((a) => a.is_default)!
    expect(addTransaction.mock.calls[0][0].account_id).toBe(main.id)
    expect(addTransaction.mock.calls[0][0].currency).toBe('UAH')
  })

  it('R21: an expense that matches no category is saved to «Прочее»', async () => {
    const { env, submit, addTransaction } = await setup()
    const other = (await env.db.categories.toArray()).find((c) => c.name === 'Прочее' && c.kind === 'expense')!
    expect(other).toBeTruthy()

    submit('непонятное 50')

    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1))
    expect(addTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'expense', amount: 50, category_id: other.id }),
    )
  })

  it('ignores an empty submit', async () => {
    const { submit, addTransaction } = await setup()
    submit('   ')
    expect(addTransaction).not.toHaveBeenCalled()
  })
})
