import { nbuUrl, parseNbu } from '../_shared/fx.ts'
import type { FxRate } from '../_shared/types.ts'

export interface FxDeps {
  fetchNbu(url: string): Promise<unknown>
  readRates(date: string): Promise<FxRate[]>
  writeRates(rows: FxRate[]): Promise<void>
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BASE_CURRENCIES = ['UAH', 'USD', 'EUR', 'MDL']

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export async function handleFxRequest(req: Request, deps: FxDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const { date, currencies } = (body ?? {}) as { date?: unknown; currencies?: unknown }
  if (typeof date !== 'string' || !isRealDate(date)) {
    return json({ error: 'Body must be { date: "YYYY-MM-DD" }' }, 400)
  }

  const wanted = [...BASE_CURRENCIES]
  if (Array.isArray(currencies)) {
    for (const c of currencies) {
      if (typeof c === 'string' && /^[A-Z]{3}$/.test(c) && !wanted.includes(c)) wanted.push(c)
    }
  }

  try {
    // a hit only when every wanted currency is cached for that date (a newly added one is not yet)
    const cached = await deps.readRates(date)
    const have = new Set(cached.filter((r) => r.date === date).map((r) => r.currency))
    if (wanted.every((c) => have.has(c))) return json(cached)
  } catch {
    // cache read failure is not fatal: fall through to NBU
  }

  let rows: FxRate[]
  try {
    rows = parseNbu(await deps.fetchNbu(nbuUrl(date)), wanted)
  } catch (e) {
    return json({ error: `NBU request failed: ${e instanceof Error ? e.message : String(e)}` }, 502)
  }
  if (rows.length === 0) return json([])

  try {
    await deps.writeRates(rows)
  } catch {
    // caching is best-effort; still return the fetched rates
  }
  return json(rows)
}
