import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from '../ui/Sheet.tsx'
import { applyLayout } from './layout.ts'

function renderSheet(onClose = vi.fn()) {
  const r = render(
    <>
      <button type="button">Под шторкой</button>
      <Sheet onClose={onClose} title="Запись" trailing={{ label: 'Готово' }}>
        <input aria-label="Сумма" />
      </Sheet>
    </>,
  )
  return { ...r, onClose }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('record sheet: focus stays inside (stage 2 carry-over), PC dialog (spec §11)', () => {
  it('Tab and Shift+Tab go round inside the sheet', () => {
    renderSheet()
    const dialog = screen.getByRole('dialog')
    const cancel = screen.getByRole('button', { name: 'Отмена' })
    const amount = screen.getByLabelText('Сумма')
    amount.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(amount)
  })

  it('the page under the sheet is inert while it is open, and back after', async () => {
    const { container, onClose } = renderSheet()
    expect((container as HTMLElement).inert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((container as HTMLElement).inert).toBe(false)
  })

  it('PC: no pulling, and it closes in 0.14 s', () => {
    vi.useFakeTimers()
    act(() => applyLayout('full'))
    const { onClose } = renderSheet()
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(dialog, { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerType: 'mouse', clientX: 10, clientY: 300 })
    expect(dialog.style.transform).toBe('')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(dialog.className).toContain('closing')
    act(() => vi.advanceTimersByTime(139))
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
