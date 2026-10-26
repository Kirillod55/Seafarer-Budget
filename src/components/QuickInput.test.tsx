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

  it('never files into a category in the undo bin: «такси 15 eur» goes to «Прочее» once its category is removed', async () => {
    const { env, submit, addTransaction } = await setup()
    const categories = await env.db.categories.toArray()
    const transport = categories.find((c) => c.name === 'Транспорт и такси')!
    const other = categories.find((c) => c.name === 'Прочее')!
    await env.repo.remove('categories', transport.id)

    submit('такси 15 eur')

    await waitFor(() => expect(addTransaction).toHaveBeenCalledTimes(1))
    expect(addTransaction.mock.calls[0][0].category_id).toBe(other.id)
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

  it('new records carry the 1.1 fields explicitly: author owner, not archived', async () => {
    const { submit, addTransaction } = await setup()
    submit('кофе 80')
    await waitFor(() => expect(addTransaction).toHaveBeenCalled())
    expect(addTransaction.mock.calls[0][0]).toMatchObject({ author: 'owner', archived: false })
  })

  it('the hint shows only on focus, after an error or after a record (§6)', async () => {
    const { input, submit } = await setup()
    const hint = () => document.querySelector('.qhint') as HTMLElement
    expect(hint().className).not.toContain('show')
    await waitFor(() => expect(hint().textContent).toMatch(/Сумма, валюта \(₴ по умолчанию\)/))

    fireEvent.focus(input)
    expect(hint().className).toContain('show')
    fireEvent.blur(input)
    expect(hint().className).not.toContain('show')

    submit('кофе')
    await waitFor(() => expect(hint().className).toContain('err'))
    expect(hint().className).toContain('show')

    submit('кофе 80')
    // an expense without «−»: «Записал: Кафе и рестораны · ₴80»
    await waitFor(() => expect(hint().textContent).toBe('Записал: Кафе и рестораны · ₴80'))
    expect(hint().className).toContain('show')
    expect(hint().className).not.toContain('err')
  })

  it('the send button is the lime arrow up «Записать», never «＋»', async () => {
    await setup()
    const send = screen.getByRole('button', { name: 'Записать' })
    expect(send.className).toContain('qsend')
    expect(send.textContent).toBe('')
  })

  it('ignores an empty submit', async () => {
    const { submit, addTransaction } = await setup()
    submit('   ')
    expect(addTransaction).not.toHaveBeenCalled()
  })
})
