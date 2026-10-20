import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import App from './App'

it('renders the app title', () => {
  render(<App />)
  expect(screen.getByText('Seafarer Budget')).toBeTruthy()
})

it('without Supabase env says the connection is not configured instead of crashing', () => {
  render(<App />)
  expect(screen.getByText(/Не настроено подключение к Supabase/)).toBeTruthy()
})

it('cleans up the DOM between tests', () => {
  render(<App />)
  expect(screen.getAllByText('Seafarer Budget')).toHaveLength(1)
})
