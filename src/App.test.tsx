import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import App from './App'

// supabase.ts reads VITE_SUPABASE_* at import time, so a local .env would make the client exist.
// These tests are about the «not configured» path, so they pin the client to null.
vi.mock('./supabase.ts', () => ({ supabase: null }))

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
