// Smoke test for the Supabase schema: rev stamping, owner-only RLS, locked-down tables.
// Run:  node --env-file=.env scripts/verify-db.mjs
// Needs SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY),
// OWNER_EMAIL and OWNER_PASSWORD in the environment.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
const email = process.env.OWNER_EMAIL
const password = process.env.OWNER_PASSWORD

const missing = [
  ['SUPABASE_URL / VITE_SUPABASE_URL', url],
  ['SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY', anonKey],
  ['OWNER_EMAIL', email],
  ['OWNER_PASSWORD', password],
].filter(([, v]) => !v)
if (missing.length) {
  console.error('Missing env: ' + missing.map(([n]) => n).join(', '))
  process.exit(2)
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const PERMISSION_DENIED = '42501'

function check(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('ok   ' + msg)
}

function ensure(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

const owner = createClient(url, anonKey, opts)
const anon = createClient(url, anonKey, opts)

const { data: auth, error: authError } = await owner.auth.signInWithPassword({ email, password })
if (authError) throw new Error('sign-in failed: ' + authError.message)
const userId = auth.user.id

const id = randomUUID()
let created = false

try {
  // 1. insert without user_id / rev (exactly what the app sends) -> server stamps both
  ensure(
    await owner.from('categories').insert({
      id,
      deleted: false,
      name: 'verify-db',
      kind: 'expense',
      icon: '🧪',
      keywords: ['verify'],
      archived: false,
      sort: 0,
    }),
    'insert category',
  )
  created = true
  const first = ensure(await owner.from('categories').select('id, rev, user_id').eq('id', id).single(), 'select inserted')
  check(first.rev !== null && first.rev !== undefined, 'insert stamps a non-null rev')
  check(first.user_id === userId, 'insert defaults user_id to the signed-in user')

  // 2. update -> rev grows
  ensure(await owner.from('categories').update({ name: 'verify-db 2' }).eq('id', id), 'update category')
  const second = ensure(await owner.from('categories').select('rev').eq('id', id).single(), 'select updated')
  check(Number(second.rev) > Number(first.rev), `update bumps rev (${first.rev} -> ${second.rev})`)

  // 3. upsert on id (the app's push path) -> rev grows again, user_id stays put
  const up = ensure(
    await owner
      .from('categories')
      .upsert(
        [{ id, deleted: false, name: 'verify-db 3', kind: 'expense', icon: '🧪', keywords: [], archived: false, sort: 0 }],
        { onConflict: 'id' },
      )
      .select('id, rev, user_id'),
    'upsert category',
  )
  check(Number(up[0].rev) > Number(second.rev), `upsert bumps rev (${second.rev} -> ${up[0].rev})`)
  check(up[0].user_id === userId, 'upsert keeps user_id')

  // 4. user_id is immutable: trying to reassign it is ignored by the trigger
  const other = randomUUID()
  ensure(await owner.from('categories').update({ user_id: other }).eq('id', id), 'update with foreign user_id')
  const afterMove = ensure(
    await owner.from('categories').select('user_id, rev').eq('id', id).single(),
    'select after user_id change',
  )
  check(Number(afterMove.rev) > Number(up[0].rev), `user_id update went through and bumped rev (${up[0].rev} -> ${afterMove.rev})`)
  check(afterMove.user_id === userId, 'user_id cannot be reassigned (trigger keeps the old owner)')

  // 4b. RLS probe: inserting a row owned by somebody else must be rejected, and leave nothing behind
  const foreignId = randomUUID()
  const foreign = await owner.from('categories').insert({
    id: foreignId,
    user_id: randomUUID(),
    deleted: false,
    name: 'verify-db foreign',
    kind: 'expense',
    icon: '',
    keywords: [],
    archived: false,
    sort: 0,
  })
  check(foreign.error?.code === PERMISSION_DENIED, `insert with a foreign user_id is rejected by RLS (code ${foreign.error?.code})`)
  const leftover = ensure(await owner.from('categories').select('id').eq('id', foreignId), 'select foreign probe row')
  check(leftover.length === 0, 'rejected foreign insert left nothing behind')

  // 5. signed-out client sees nothing (0 rows, or no privilege at all)
  const anonRead = await anon.from('categories').select('id')
  if (anonRead.error) {
    check(anonRead.error.code === PERMISSION_DENIED, `anon read rejected (${anonRead.error.code}: ${anonRead.error.message})`)
  } else {
    check(anonRead.data.length === 0, 'anon read of categories returns 0 rows')
  }

  // 6. fx_rates: readable when signed in, not writable; bot_updates: closed to clients
  ensure(await owner.from('fx_rates').select('date, currency, uah_per_unit').limit(1), 'authenticated read of fx_rates')
  const fxWrite = await owner.from('fx_rates').insert({ date: '2000-01-01', currency: 'XXX', uah_per_unit: 1 })
  check(!!fxWrite.error, 'authenticated cannot insert into fx_rates')
  const botRead = await owner.from('bot_updates').select('update_id').limit(1)
  check(!!botRead.error || (botRead.data ?? []).length === 0, 'authenticated cannot read bot_updates')
  const botWrite = await owner.from('bot_updates').insert({ update_id: 1 })
  check(!!botWrite.error, 'authenticated cannot insert into bot_updates')
} finally {
  // Clean up: hard-delete the test row (the owner has DELETE under RLS), leaving no tombstone.
  if (created) {
    const del = await owner.from('categories').delete().eq('id', id)
    if (del.error) console.error('cleanup failed, test row may remain: ' + del.error.message)
    else console.log('ok   test row deleted')
  }
  await owner.auth.signOut()
}

console.log('DB OK')
