import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createSupabaseRemote } from './remote-supabase.ts'
import { RowRejectedError } from './sync.ts'

interface Query {
  table: string
  calls: [string, unknown[]][]
}
type Answer = { data: unknown; error: { message: string; code?: string } | null; status: number }

/** A query-builder stand-in: records the chain, answers via `handler` when awaited. */
function fakeClient(handler: (q: Query) => Answer, invoke = vi.fn(async () => ({ data: [], error: null }))) {
  const queries: Query[] = []
  const client = {
    from(table: string) {
      const q: Query = { table, calls: [] }
      queries.push(q)
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (res: (v: Answer) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => handler(q)).then(res, rej)
            }
            return (...args: unknown[]) => {
              q.calls.push([prop, args])
              return builder
            }
          },
        },
      )
      return builder
    },
    functions: { invoke },
  }
  return { client: client as unknown as SupabaseClient, queries, invoke }
}

const arg = (q: Query, name: string) => q.calls.find(([n]) => n === name)?.[1]

describe('pull (D1: keyset paging)', () => {
  it('pages by rev > last seen with limit, never by offset', async () => {
    const server = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i + 1}`, rev: i + 1 }))
    const { client, queries } = fakeClient((q) => {
      const since = arg(q, 'gt')![1] as number
      const limit = arg(q, 'limit')![0] as number
      return { data: server.filter((r) => r.rev > since).slice(0, limit), error: null, status: 200 }
    })
    const rows = await createSupabaseRemote(client).pull('transactions', 0)
    expect(rows).toHaveLength(2500)
    expect(queries.map((q) => arg(q, 'gt'))).toEqual([
      ['rev', 0],
      ['rev', 1000],
      ['rev', 2000],
    ])
    expect(queries.every((q) => !q.calls.some(([n]) => n === 'range'))).toBe(true)
    expect(arg(queries[0], 'order')).toEqual(['rev', { ascending: true }])
  })

  it('a row updated between pages does not make the next page skip a row', async () => {
    const server = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i + 1}`, rev: i + 1 }))
    let page = 0
    const { client } = fakeClient((q) => {
      const since = (arg(q, 'gt')?.[1] as number | undefined) ?? 0
      const sorted = server.filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev)
      const range = arg(q, 'range') as [number, number] | undefined
      const out = range ? sorted.slice(range[0], range[1] + 1) : sorted.slice(0, arg(q, 'limit')![0] as number)
      // after the first page the bot edits r5: it moves to the end of the rev order
      if (page++ === 0) server[4] = { id: 'r5', rev: 1501 }
      return { data: out, error: null, status: 200 }
    })
    const rows = (await createSupabaseRemote(client).pull('accounts', 0)) as { id: string }[]
    expect(rows.map((r) => r.id)).toContain('r1001')
  })
})

describe('push', () => {
  it('maps a 4xx server refusal to RowRejectedError', async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: 'violates check constraint', code: '23514' }, status: 400 }))
    await expect(createSupabaseRemote(client).push('accounts', [{ id: 'a' }])).rejects.toBeInstanceOf(RowRejectedError)
  })

  it('a network failure or expired token is not a row rejection', async () => {
    for (const status of [0, 401, 500, 503]) {
      const { client } = fakeClient(() => ({ data: null, error: { message: 'TypeError: Failed to fetch' }, status }))
      const err = await createSupabaseRemote(client).push('accounts', [{ id: 'a' }]).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(RowRejectedError)
    }
  })
})

describe('patchRates (I3)', () => {
  it('updates only the rate columns of rows still pending on the server', async () => {
    const { client, queries } = fakeClient(() => ({ data: null, error: null, status: 204 }))
    await createSupabaseRemote(client).patchRates([{ id: 't1', rate_usd: 0.025, amount_usd: 2 }])
    expect(queries).toHaveLength(1)
    expect(queries[0].table).toBe('transactions')
    expect(queries[0].calls).toEqual([
      ['update', [{ rate_usd: 0.025, amount_usd: 2, rate_pending: false }]],
      ['eq', ['id', 't1']],
      ['eq', ['rate_pending', true]],
    ])
  })
})

describe('fxRates (I2)', () => {
  it('sends the wanted currencies to the fx-rates function', async () => {
    const { client, invoke } = fakeClient(() => ({ data: null, error: null, status: 200 }))
    await createSupabaseRemote(client).fxRates('2026-10-21', ['UAH', 'USD', 'GBP'])
    expect(invoke).toHaveBeenCalledWith('fx-rates', { body: { date: '2026-10-21', currencies: ['UAH', 'USD', 'GBP'] } })
  })
})
