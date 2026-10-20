// Supabase Edge Function (Deno). Not imported by vitest or type-checked by the app build.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleFxRequest } from './handler.ts'
import type { FxRate } from '../_shared/types.ts'

const NBU_TIMEOUT_MS = 10_000 // a hung NBU must not hang the function

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

Deno.serve((req: Request) =>
  handleFxRequest(req, {
    async fetchNbu(url: string) {
      const res = await fetch(url, { signal: AbortSignal.timeout(NBU_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`NBU responded ${res.status}`)
      return await res.json()
    },
    async readRates(date: string) {
      const { data, error } = await admin.from('fx_rates').select('date,currency,uah_per_unit').eq('date', date)
      if (error) throw new Error(error.message)
      return (data ?? []) as FxRate[]
    },
    async writeRates(rows: FxRate[]) {
      const { error } = await admin.from('fx_rates').upsert(rows, { onConflict: 'date,currency' })
      if (error) throw new Error(error.message)
    },
  }),
)
