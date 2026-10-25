// @vitest-environment node
// SQL checks on PGlite (real Postgres compiled to WASM): the migrations in supabase/migrations
// are applied on top of small stubs for what Supabase itself provides (auth schema, roles,
// realtime publication). PGlite/WASM is unreliable under jsdom, hence the node environment.
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS = new URL('./migrations/', import.meta.url)
const UID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1'

// What Supabase creates before our migrations run, reduced to what init.sql touches.
const SUPABASE_STUBS = `
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  do $$
  declare r text;
  begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin', r);
      end if;
    end loop;
  end $$;
  create publication supabase_realtime;
`

interface OpenOptions {
  /** Create the function Supabase adds to live projects (not in our migrations). */
  withRlsAutoEnable?: boolean
}

export async function openDb(options: OpenOptions = {}): Promise<PGlite> {
  const db = await PGlite.create()
  await db.exec(SUPABASE_STUBS)
  if (options.withRlsAutoEnable) {
    await db.exec(`create function public.rls_auto_enable() returns void language sql as $$ select $$;`)
  }
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  await db.query('insert into auth.users (id) values ($1)', [UID])
  await db.exec(`set test.uid = '${UID}'`)
  return db
}

let seq = 0
/** A fresh uuid per test row, so tests sharing one database never collide. */
function newId(): string {
  seq += 1
  return `10000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`
}

type Row = Record<string, unknown>

async function one(db: PGlite, sql: string, params: unknown[] = []): Promise<Row> {
  const res = await db.query<Row>(sql, params)
  expect(res.rows).toHaveLength(1)
  return res.rows[0]
}

/** The INSERT a 1.0 client makes: only columns that existed in 1.0. */
async function insertTx1_0(db: PGlite, id: string, note = ''): Promise<Row> {
  return one(
    db,
    `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, note)
     values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', $3)
     returning *`,
    [id, ACCOUNT, note],
  )
}

describe('v1.1 migration on PGlite', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await openDb()
  })

  afterAll(async () => {
    await db?.close()
  })

  it('migrations apply cleanly on top of 1.0', async () => {
    const fresh = await openDb()
    const tables = await fresh.query<{ n: number }>(
      `select count(*)::int as n from pg_tables where schemaname = 'public'`,
    )
    expect(tables.rows[0].n).toBe(9)
    await fresh.close()
  })

  it('1.0 client insert gets defaults', async () => {
    const id = newId()
    await one(
      db,
      `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25') returning id`,
      [id, ACCOUNT],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.author).toBe('owner')
    expect(row.archived).toBe(false)
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_batch).toBeNull()
    expect(row.user_id).toBe(UID)
  })

  it('1.0 client update does not wipe new fields', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    await db.query(`update public.transactions set author = 'partner', archived = true where id = $1`, [id])
    // PostgREST upsert from a 1.0 client: the SET list holds only the columns that client sends.
    await db.query(
      `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, note)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', 'edited')
       on conflict (id) do update set
         kind = excluded.kind, amount = excluded.amount, currency = excluded.currency,
         rate_usd = excluded.rate_usd, amount_usd = excluded.amount_usd,
         account_id = excluded.account_id, date = excluded.date, note = excluded.note`,
      [id, ACCOUNT],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.note).toBe('edited')
    expect(row.author).toBe('partner')
    expect(row.archived).toBe(true)
  })

  it('deleted stays deleted', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    await db.query('update public.transactions set deleted = true where id = $1', [id])
    await db.query('update public.transactions set deleted = false where id = $1', [id])
    const row = await one(db, 'select deleted from public.transactions where id = $1', [id])
    expect(row.deleted).toBe(true)
  })

  it('stale edit does not resurrect a soft-deleted row', async () => {
    const id = newId()
    const r = (await insertTx1_0(db, id)).rev
    const r2 = (
      await one(
        db,
        `update public.transactions set deleted_at = now(), deleted_batch = gen_random_uuid()
         where id = $1 returning rev`,
        [id],
      )
    ).rev
    expect(Number(r2)).toBeGreaterThan(Number(r))
    await db.query(
      `update public.transactions set note = 'x', deleted_at = null, deleted_batch = null, base_rev = $2
       where id = $1`,
      [id, r],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_batch).not.toBeNull()
    expect(row.note).toBe('x')
    // base_rev is per request: the trigger never stores it
    expect(row.base_rev).toBeNull()
  })

  it('restore by a client that saw the deletion works', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    const r2 = (
      await one(
        db,
        `update public.transactions set deleted_at = now(), deleted_batch = gen_random_uuid()
         where id = $1 returning rev`,
        [id],
      )
    ).rev
    await db.query(
      `update public.transactions set deleted_at = null, deleted_batch = null, base_rev = $2 where id = $1`,
      [id, r2],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_batch).toBeNull()
  })

  it('settings check rejects negative reserve', async () => {
    await expect(
      db.query(
        `insert into public.settings
           (id, base_currency, default_currency, currencies, accounts_mode, status, salary_lag_days, timezone, reserve_usd)
         values ($1, 'USD', 'USD', '{USD}', 'single', 'home', 0, 'Europe/Kyiv', -1)`,
        [newId()],
      ),
    ).rejects.toThrow(/violates check constraint "settings_reserve_usd_check"/)
  })

  // Extra checks beyond the brief's list.

  it('stale upsert does not resurrect a soft-deleted row', async () => {
    // The app pushes through PostgREST upsert, so base_rev arrives via EXCLUDED, not a plain UPDATE.
    const id = newId()
    const r = (await insertTx1_0(db, id)).rev
    await db.query(`update public.transactions set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1`, [id])
    await db.query(
      `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, note, deleted_at, deleted_batch, base_rev)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', 'y', null, null, $3)
       on conflict (id) do update set
         note = excluded.note, deleted_at = excluded.deleted_at,
         deleted_batch = excluded.deleted_batch, base_rev = excluded.base_rev`,
      [id, ACCOUNT, r],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.deleted_at).not.toBeNull()
    expect(row.note).toBe('y')
  })

  it('new columns have their defaults and checks', async () => {
    const id = newId()
    const s = await one(
      db,
      `insert into public.settings
         (id, base_currency, default_currency, currencies, accounts_mode, status, salary_lag_days, timezone)
       values ($1, 'USD', 'USD', '{USD}', 'single', 'home', 0, 'Europe/Kyiv') returning *`,
      [id],
    )
    expect(Number(s.reserve_usd)).toBe(0)
    expect(s.remind_after_days).toBe(2)
    expect(s.daily_summary_owner).toBe(false)
    expect(s.daily_summary_partner).toBe(false)
    expect(s.partner_name).toBeNull()
    await expect(db.query('update public.settings set remind_after_days = 4 where id = $1', [id])).rejects.toThrow()
    // a stale base_rev on a table without deleted_at (settings) is simply ignored
    const upd = await one(db, 'update public.settings set reserve_usd = 5, base_rev = 0 where id = $1 returning *', [id])
    expect(Number(upd.reserve_usd)).toBe(5)
    expect(upd.base_rev).toBeNull()
    await expect(
      db.query(`update public.transactions set author = 'guest' where account_id = $1`, [ACCOUNT]),
    ).rejects.toThrow()

    const move = await one(
      db,
      `insert into public.goal_moves (id, goal_id, amount_usd, date) values ($1, $2, 5, '2026-10-25') returning *`,
      [newId(), newId()],
    )
    expect(move.author).toBe('owner')
    expect(move.source).toBe('app')
    expect(move.created_at).toBeInstanceOf(Date)

    const cat = await one(
      db,
      `insert into public.categories (id, name, kind) values ($1, 'Еда', 'expense') returning *`,
      [newId()],
    )
    expect(cat.color).toBeNull()
    expect(cat.glyph).toBeNull()
    expect(cat.deleted_at).toBeNull()

    for (const t of ['settings', 'accounts', 'categories', 'transactions', 'goals', 'goal_moves', 'limits']) {
      const col = await db.query(
        `select 1 from information_schema.columns
         where table_schema = 'public' and table_name = $1 and column_name = 'base_rev' and data_type = 'bigint'`,
        [t],
      )
      expect(col.rows, t).toHaveLength(1)
    }
  })

  it('rls_auto_enable is revoked from client roles when present', async () => {
    const live = await openDb({ withRlsAutoEnable: true })
    for (const role of ['anon', 'authenticated']) {
      const res = await one(live, `select has_function_privilege($1, 'public.rls_auto_enable()', 'execute') as ok`, [role])
      expect(res.ok, role).toBe(false)
    }
    await live.close()
  })
})
