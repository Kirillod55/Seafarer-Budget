import { describe, expect, it, vi } from 'vitest'
import type { FxRate } from '../_shared/types.ts'
import { handleFxRequest, type FxDeps } from './handler.ts'

const NBU = [
  { cc: 'USD', rate: 41.5, exchangedate: '20.10.2026' },
  { cc: 'EUR', rate: 48.2, exchangedate: '20.10.2026' },
  { cc: 'MDL', rate: 2.4, exchangedate: '20.10.2026' },
  { cc: 'GBP', rate: 55.1, exchangedate: '20.10.2026' },
]

function makeDeps(over: Partial<FxDeps> = {}): FxDeps & {
  fetchNbu: ReturnType<typeof vi.fn>
  readRates: ReturnType<typeof vi.fn>
  writeRates: ReturnType<typeof vi.fn>
} {
  return {
    fetchNbu: vi.fn(async () => NBU),
    readRates: vi.fn(async () => [] as FxRate[]),
    writeRates: vi.fn(async () => {}),
    ...over,
  } as never
}

function post(body: unknown): Request {
  return new Request('http://localhost/fx-rates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('handleFxRequest', () => {
  it('answers OPTIONS with 200 and CORS headers', async () => {
    const res = await handleFxRequest(new Request('http://localhost/fx-rates', { method: 'OPTIONS' }), makeDeps())
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('authorization, x-client-info, apikey, content-type')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
  })

  it('rejects non-POST methods with 405', async () => {
    const res = await handleFxRequest(new Request('http://localhost/fx-rates', { method: 'GET' }), makeDeps())
    expect(res.status).toBe(405)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it.each([
    ['missing date', {}],
    ['malformed date', { date: '20-10-2026' }],
    ['non-string date', { date: 20261020 }],
    ['impossible date', { date: '2026-13-45' }],
    ['not JSON', 'nope'],
  ])('returns 400 for %s', async (_name, body) => {
    const deps = makeDeps()
    const res = await handleFxRequest(post(body), deps)
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(typeof (await res.json()).error).toBe('string')
    expect(deps.fetchNbu).not.toHaveBeenCalled()
  })

  it('returns cached rows without calling NBU when USD is covered', async () => {
    const cached: FxRate[] = [
      { date: '2026-10-20', currency: 'USD', uah_per_unit: 41.5 },
      { date: '2026-10-20', currency: 'UAH', uah_per_unit: 1 },
    ]
    const deps = makeDeps({ readRates: vi.fn(async () => cached) })
    const res = await handleFxRequest(post({ date: '2026-10-20' }), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await res.json()).toEqual(cached)
    expect(deps.fetchNbu).not.toHaveBeenCalled()
    expect(deps.writeRates).not.toHaveBeenCalled()
  })

  it('fetches NBU when cached rows lack USD', async () => {
    const deps = makeDeps({
      readRates: vi.fn(async () => [{ date: '2026-10-20', currency: 'EUR', uah_per_unit: 48.2 }]),
    })
    const res = await handleFxRequest(post({ date: '2026-10-20' }), deps)
    expect(res.status).toBe(200)
    expect(deps.fetchNbu).toHaveBeenCalledTimes(1)
  })

  it('on cache miss fetches NBU, writes rows (with UAH) and returns them', async () => {
    const deps = makeDeps()
    const res = await handleFxRequest(post({ date: '2026-10-20' }), deps)
    expect(res.status).toBe(200)
    expect(deps.fetchNbu).toHaveBeenCalledWith(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=20261020&json',
    )
    const body = (await res.json()) as FxRate[]
    expect(body).toEqual(
      expect.arrayContaining([
        { date: '2026-10-20', currency: 'USD', uah_per_unit: 41.5 },
        { date: '2026-10-20', currency: 'EUR', uah_per_unit: 48.2 },
        { date: '2026-10-20', currency: 'MDL', uah_per_unit: 2.4 },
        { date: '2026-10-20', currency: 'UAH', uah_per_unit: 1 },
      ]),
    )
    expect(body.find((r) => r.currency === 'GBP')).toBeUndefined()
    expect(deps.writeRates).toHaveBeenCalledTimes(1)
    expect(deps.writeRates).toHaveBeenCalledWith(body)
  })

  it('includes extra currencies passed by the client', async () => {
    const deps = makeDeps()
    const res = await handleFxRequest(post({ date: '2026-10-20', currencies: ['GBP', 'bad!', 42] }), deps)
    const body = (await res.json()) as FxRate[]
    expect(body.find((r) => r.currency === 'GBP')).toEqual({ date: '2026-10-20', currency: 'GBP', uah_per_unit: 55.1 })
  })

  it('returns [] and writes nothing when NBU returns []', async () => {
    const deps = makeDeps({ fetchNbu: vi.fn(async () => []) })
    const res = await handleFxRequest(post({ date: '2099-01-01' }), deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(deps.writeRates).not.toHaveBeenCalled()
  })

  it('returns 502 when NBU fetch throws', async () => {
    const deps = makeDeps({
      fetchNbu: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const res = await handleFxRequest(post({ date: '2026-10-20' }), deps)
    expect(res.status).toBe(502)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(typeof (await res.json()).error).toBe('string')
    expect(deps.writeRates).not.toHaveBeenCalled()
  })
})
