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
  const { date, dates, currencies } = (body ?? {}) as { date?: unknown; dates?: unknown; currencies?: unknown }
  const wanted = [...BASE_CURRENCIES]
  if (Array.isArray(currencies)) {
    for (const c of currencies) {
      if (typeof c === 'string' && /^[A-Z]{3}$/.test(c) && !wanted.includes(c)) wanted.push(c)
    }
  }

  // several dates at once (after a big CSV import): one NBU call per date that is not cached
  if (Array.isArray(dates)) {
    const list = [...new Set(dates)]
    if (list.length === 0 || list.length > MAX_DATES || !list.every((d) => typeof d === 'string' && isRealDate(d))) {
      return json({ error: `Body must be { dates: ["YYYY-MM-DD", …] } with 1–${MAX_DATES} dates` }, 400)
    }
    const out: FxRate[] = []
    for (const d of list as string[]) {
      const r = await ratesFor(d, wanted, deps)
      if ('rows' in r) out.push(...r.rows)
    }
    return json(out)
  }

  if (typeof date !== 'string' || !isRealDate(date)) {
    return json({ error: 'Body must be { date: "YYYY-MM-DD" }' }, 400)
  }
  const r = await ratesFor(date, wanted, deps)
  return 'rows' in r ? json(r.rows) : json({ error: r.error }, 502)
}

const MAX_DATES = 60

async function ratesFor(date: string, wanted: string[], deps: FxDeps): Promise<{ rows: FxRate[] } | { error: string }> {
  try {
    // a hit only when every wanted currency is cached for that date (a newly added one is not yet)
    const cached = await deps.readRates(date)
    const have = new Set(cached.filter((r) => r.date === date).map((r) => r.currency))
    if (wanted.every((c) => have.has(c))) return { rows: cached }
  } catch {
    // cache read failure is not fatal: fall through to NBU
  }

  let rows: FxRate[]
  try {
    rows = parseNbu(await deps.fetchNbu(nbuUrl(date)), wanted)
  } catch (e) {
    return { error: `NBU request failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (rows.length === 0) return { rows: [] }

  try {
    await deps.writeRates(rows)
  } catch {
    // caching is best-effort; still return the fetched rates
  }
  return { rows }
}