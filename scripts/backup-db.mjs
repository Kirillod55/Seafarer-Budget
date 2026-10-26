// Full JSON copy of the owner's data before a migration or a release.
// Run:  node --env-file=.env scripts/backup-db.mjs
// Writes backups/db-<UTC timestamp>.json (git-ignored) and prints only row counts.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const { OWNER_EMAIL: email, OWNER_PASSWORD: password } = process.env
if (!url || !anonKey || !email || !password) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, OWNER_PASSWORD')
  process.exit(2)
}

const TABLES = ['settings', 'accounts', 'categories', 'transactions', 'goals', 'goal_moves', 'limits', 'fx_rates']
const PAGE = 1000

const db = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
const { error: authError } = await db.auth.signInWithPassword({ email, password })
if (authError) {
  console.error('Sign-in failed: ' + authError.message)
  process.exit(1)
}

const copy = { taken_at: new Date().toISOString(), tables: {} }
for (const table of TABLES) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select('*').range(from, from + PAGE - 1)
    if (error) {
      console.error(`${table}: ${error.message}`)
      process.exit(1)
    }
    rows.push(...data)
    if (data.length < PAGE) break
  }
  copy.tables[table] = rows
  console.log(`${table}: ${rows.length}`)
}

mkdirSync('backups', { recursive: true })
const file = `backups/db-${copy.taken_at.replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(copy))
console.log('saved ' + file)
