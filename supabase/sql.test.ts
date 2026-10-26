// @vitest-environment node
// SQL checks on PGlite (real Postgres compiled to WASM): the migrations in supabase/migrations
// are applied on top of small stubs for what Supabase itself provides (auth schema, roles,
// realtime publication). PGlite/WASM is unreliable under jsdom, hence the node environment.
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS = new URL('./migrations/', import.meta.url)
const V11 = '20261025120000_v11.sql'
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
  -- as on Supabase: the service role bypasses RLS, client roles may call auth.uid()
  alter role service_role bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  create publication supabase_realtime;
`

interface OpenOptions {
  /** Create the function Supabase adds to live projects (not in our migrations), executable by clients. */
  withRlsAutoEnable?: boolean
  /** Run before the named migration file, e.g. to seed 1.0 data that the 1.1 migration must carry over. */
  beforeFile?: Record<string, (db: PGlite) => Promise<void>>
}

export async function openDb(options: OpenOptions = {}): Promise<PGlite> {
  const db = await PGlite.create()
  await db.exec(SUPABASE_STUBS)
  await db.query('insert into auth.users (id) values ($1)', [UID])
  await db.exec(`set test.uid = '${UID}'`)
  if (options.withRlsAutoEnable) {
    await db.exec(`
      create function public.rls_auto_enable() returns void language sql as $$ select $$;
      grant execute on function public.rls_auto_enable() to anon, authenticated;
    `)
  }
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await options.beforeFile?.[file]?.(db)
    await db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
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

/** A row as a client pushes it (src/db/sync.ts toWire): everything it has except rev and user_id. */
function toWire(row: Row): Row {
  const { rev: _rev, user_id: _user, ...rest } = row
  return rest
}

/**
 * What PostgREST runs for a postgrest-js `upsert(rows, { onConflict: 'id' })`: the column list is
 * the union of the keys of all rows, a key missing from a row arrives as NULL, and every listed
 * column is in the DO UPDATE SET. Values travel as JSON, as over HTTP.
 */
async function upsertLikePostgrest(db: PGlite, table: string, rows: Row[]): Promise<void> {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => `"${c}"`)
  const list = cols.join(', ')
  const set = cols.map((c) => `${c} = excluded.${c}`).join(', ')
  await db.query(
    `insert into public.${table} (${list})
     select ${list} from json_populate_recordset(null::public.${table}, $1::json)
     on conflict (id) do update set ${set}`,
    [JSON.stringify(rows)],
  )
}

/** A new row created by a 1.0 client: only columns that existed in 1.0 (the 1.1 ones are omitted). */
async function insertTx1_0(db: PGlite, id: string, note = ''): Promise<Row> {
  return one(
    db,
    `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, note)
     values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', $3)
     returning *`,
    [id, ACCOUNT, note],
  )
}

/** Soft-deletes a transaction the way 1.1 does and returns the stamped rev/deleted_at/deleted_batch. */
async function softDelete(db: PGlite, id: string): Promise<Row> {
  return one(
    db,
    `update public.transactions set deleted_at = now(), deleted_batch = gen_random_uuid()
     where id = $1 returning rev, deleted_at, deleted_batch`,
    [id],
  )
}

const time = (v: unknown) => (v as Date).getTime()

// A fresh PGlite with every migration takes ~0.8 s alone and several seconds while the full suite loads all cores:
// the default 5 s test / 10 s hook timeouts are not a judgement on the SQL here.
const SLOW = 60_000

describe('v1.1 migration on PGlite', { timeout: SLOW }, () => {
  let db: PGlite

  beforeAll(async () => {
    db = await openDb()
  }, SLOW)

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
    // A row the 1.0 client pulled before the migration: its Dexie copy has no 1.1 keys, so the
    // upsert's column list (and SET) holds only 1.0 columns.
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
    const del = await softDelete(db, id)
    expect(Number(del.rev)).toBeGreaterThan(Number(r))
    await db.query(
      `update public.transactions set note = 'x', deleted_at = null, deleted_batch = null, base_rev = $2
       where id = $1`,
      [id, r],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(time(row.deleted_at)).toBe(time(del.deleted_at))
    expect(row.deleted_batch).toBe(del.deleted_batch)
    expect(row.note).toBe('x')
    // base_rev is per request: the trigger never stores it
    expect(row.base_rev).toBeNull()
  })

  it('restore by a client that saw the deletion works', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    const r2 = (await softDelete(db, id)).rev
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
    const del = await softDelete(db, id)
    await db.query(
      `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, note, deleted_at, deleted_batch, base_rev)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', 'y', null, null, $3)
       on conflict (id) do update set
         note = excluded.note, deleted_at = excluded.deleted_at,
         deleted_batch = excluded.deleted_batch, base_rev = excluded.base_rev`,
      [id, ACCOUNT, r],
    )
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(time(row.deleted_at)).toBe(time(del.deleted_at))
    expect(row.note).toBe('y')
  })

  it('1.0 full-row echo does not resurrect a soft-deleted row', async () => {
    // A 1.0 device pulled the row after the migration (select * -> deleted_at: null, base_rev: null),
    // then a 1.1 device soft-deleted it, then the 1.0 device edits its stale copy and pushes it whole.
    const id = newId()
    await insertTx1_0(db, id)
    const pulled = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(pulled.deleted_at).toBeNull()
    expect(pulled.base_rev).toBeNull()
    const del = await softDelete(db, id)
    await upsertLikePostgrest(db, 'transactions', [{ ...toWire(pulled), note: 'edited on 1.0' }])
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(time(row.deleted_at)).toBe(time(del.deleted_at))
    expect(row.deleted_batch).toBe(del.deleted_batch)
    expect(row.note).toBe('edited on 1.0')
    // the same through a plain UPDATE without base_rev
    await db.query('update public.transactions set deleted_at = null, deleted_batch = null where id = $1', [id])
    const again = await one(db, 'select deleted_at from public.transactions where id = $1', [id])
    expect(time(again.deleted_at)).toBe(time(del.deleted_at))
  })

  it('restore through upsert with base_rev = current rev works', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    await softDelete(db, id)
    const pulled = await one(db, 'select * from public.transactions where id = $1', [id])
    await upsertLikePostgrest(db, 'transactions', [
      { ...toWire(pulled), deleted_at: null, deleted_batch: null, base_rev: Number(pulled.rev) },
    ])
    const row = await one(db, 'select * from public.transactions where id = $1', [id])
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_batch).toBeNull()
  })

  it('1.1 columns sent as NULL get their defaults on insert', async () => {
    // plain INSERT with explicit NULLs
    const t1 = newId()
    await db.query(
      `insert into public.transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, author, archived)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', null, null)`,
      [t1, ACCOUNT],
    )
    const r1 = await one(db, 'select author, archived from public.transactions where id = $1', [t1])
    expect(r1).toEqual({ author: 'owner', archived: false })

    // a postgrest-js batch: a new 1.0 row next to a row that has the 1.1 keys -> NULLs for the new one
    const t2 = newId()
    const t3 = newId()
    const base = { kind: 'expense', amount: 10, currency: 'USD', rate_usd: 1, amount_usd: 10, account_id: ACCOUNT, date: '2026-10-25', note: '' }
    await upsertLikePostgrest(db, 'transactions', [
      { id: t2, ...base },
      { id: t3, ...base, author: 'partner', archived: true },
    ])
    const r2 = await one(db, 'select author, archived from public.transactions where id = $1', [t2])
    expect(r2).toEqual({ author: 'owner', archived: false })
    const r3 = await one(db, 'select author, archived from public.transactions where id = $1', [t3])
    expect(r3).toEqual({ author: 'partner', archived: true })

    const m = newId()
    const move = await one(
      db,
      `insert into public.goal_moves (id, goal_id, amount_usd, date, author, source, created_at)
       values ($1, $2, 5, '2026-10-25', null, null, null) returning author, source, created_at`,
      [m, newId()],
    )
    expect(move.author).toBe('owner')
    expect(move.source).toBe('app')
    expect(move.created_at).toBeInstanceOf(Date)
  })

  it('1.1 columns sent as NULL keep their stored values on update', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    await db.query(`update public.transactions set author = 'partner', archived = true where id = $1`, [id])
    const pulledOld = toWire(await one(db, 'select * from public.transactions where id = $1', [id]))
    // the 1.0 copy pulled before the migration has no 1.1 keys; a new row in the batch has them
    for (const k of ['author', 'archived', 'deleted_at', 'deleted_batch', 'base_rev']) delete pulledOld[k]
    const fresh = newId()
    await upsertLikePostgrest(db, 'transactions', [
      { ...pulledOld, note: 'batch' },
      { ...pulledOld, id: fresh, author: 'owner', archived: false },
    ])
    const row = await one(db, 'select author, archived, note from public.transactions where id = $1', [id])
    expect(row).toEqual({ author: 'partner', archived: true, note: 'batch' })

    // plain UPDATE with NULLs
    await db.query('update public.transactions set author = null, archived = null where id = $1', [id])
    expect(await one(db, 'select author, archived from public.transactions where id = $1', [id])).toEqual({
      author: 'partner',
      archived: true,
    })

    const m = newId()
    const created = (
      await one(
        db,
        `insert into public.goal_moves (id, goal_id, amount_usd, date, author, source, created_at)
         values ($1, $2, 5, '2026-10-25', 'partner', 'bot', '2026-10-20T08:00:00Z') returning created_at`,
        [m, newId()],
      )
    ).created_at
    await db.query('update public.goal_moves set author = null, source = null, created_at = null where id = $1', [m])
    const move = await one(db, 'select author, source, created_at from public.goal_moves where id = $1', [m])
    expect(move.author).toBe('partner')
    expect(move.source).toBe('bot')
    expect(time(move.created_at)).toBe(time(created))

    const c = newId()
    await db.query(`insert into public.categories (id, name, kind, color, glyph) values ($1, 'Кофе', 'expense', 'orange', 'coffee')`, [c])
    await db.query('update public.categories set color = null, glyph = null where id = $1', [c])
    expect(await one(db, 'select color, glyph from public.categories where id = $1', [c])).toEqual({
      color: 'orange',
      glyph: 'coffee',
    })
  })

  it('goal_moves.created_at is backfilled from the move date', async () => {
    const m = newId()
    const seeded = await openDb({
      beforeFile: {
        [V11]: async (d) => {
          await d.query(`insert into public.goal_moves (id, goal_id, amount_usd, date) values ($1, $2, 5, '2026-03-10')`, [
            m,
            newId(),
          ])
        },
      },
    })
    const row = await one(seeded, 'select created_at, author, source from public.goal_moves where id = $1', [m])
    expect((row.created_at as Date).toISOString()).toBe('2026-03-10T12:00:00.000Z')
    expect(row.author).toBe('owner')
    expect(row.source).toBe('app')
    await seeded.close()
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

  // I1: settings columns written only by the server (bot / Edge Functions run as service_role)
  it('settings: keepalive_at, last_reminder_at, partner_seen_at change only under the service role', async () => {
    const id = newId()
    await db.query(
      `insert into public.settings
         (id, base_currency, default_currency, currencies, accounts_mode, status, salary_lag_days, timezone)
       values ($1, 'USD', 'USD', '{USD}', 'single', 'home', 0, 'Europe/Kyiv')`,
      [id],
    )
    const stale = toWire(await one(db, 'select * from public.settings where id = $1', [id]))
    const owned =
      'select keepalive_at, last_reminder_at, partner_seen_at, default_currency, reserve_usd from public.settings where id = $1'
    const iso = (r: Row) => ({
      keepalive_at: (r.keepalive_at as Date | null)?.toISOString() ?? null,
      last_reminder_at: (r.last_reminder_at as Date | null)?.toISOString() ?? null,
      partner_seen_at: (r.partner_seen_at as Date | null)?.toISOString() ?? null,
    })
    const want = {
      keepalive_at: '2026-10-20T08:00:00.000Z',
      last_reminder_at: '2026-10-21T08:00:00.000Z',
      partner_seen_at: '2026-10-22T08:00:00.000Z',
    }
    try {
      await db.exec('set role service_role')
      await db.query(
        `update public.settings set keepalive_at = $2, last_reminder_at = $3, partner_seen_at = $4,
           default_currency = 'EUR' where id = $1`,
        [id, want.keepalive_at, want.last_reminder_at, want.partner_seen_at],
      )
    } finally {
      await db.exec('reset role')
    }
    expect(iso(await one(db, owned, [id]))).toEqual(want)

    // a client (1.0 full-row echo, or any stale copy) pushes the old values: they stay as the server set them
    try {
      await db.exec('set role authenticated')
      await upsertLikePostgrest(db, 'settings', [{ ...stale, reserve_usd: 7 }])
      await db.query('update public.settings set keepalive_at = null, partner_seen_at = now() where id = $1', [id])
    } finally {
      await db.exec('reset role')
    }
    let row = await one(db, owned, [id])
    expect(iso(row)).toEqual(want)
    expect(Number(row.reserve_usd)).toBe(7)
    // the other columns of a stale whole-row push still apply (the 1.1 app pushes only changed columns)
    expect(row.default_currency).toBe('USD')

    // any role other than service_role (here the table owner) cannot change them either
    await db.query('update public.settings set last_reminder_at = null where id = $1', [id])
    row = await one(db, owned, [id])
    expect(iso(row)).toEqual(want)
  })

  it('settings: a column-scoped push must be an UPDATE (a partial upsert fails on NOT NULL)', async () => {
    const id = newId()
    const s = await one(
      db,
      `insert into public.settings
         (id, base_currency, default_currency, currencies, accounts_mode, status, salary_lag_days, timezone)
       values ($1, 'USD', 'UAH', '{USD}', 'single', 'home', 0, 'Europe/Kyiv') returning rev`,
      [id],
    )
    try {
      await db.exec('set role authenticated')
      // NOT NULL is checked on the proposed INSERT row before the conflict is found
      await expect(upsertLikePostgrest(db, 'settings', [{ id, base_rev: Number(s.rev), reserve_usd: 9 }])).rejects.toThrow(
        /not-null/,
      )
      // what remote-supabase.ts pushColumns sends: update(fields).eq('id', id)
      await db.query('update public.settings set reserve_usd = 9, base_rev = $2 where id = $1', [id, s.rev])
    } finally {
      await db.exec('reset role')
    }
    const row = await one(db, 'select reserve_usd, default_currency, base_rev from public.settings where id = $1', [id])
    expect(Number(row.reserve_usd)).toBe(9)
    expect(row.default_currency).toBe('UAH')
    expect(row.base_rev).toBeNull()
  })

  // I2: a deletion is judged by the rev that made it (deleted_rev), not by the row's latest rev
  it('soft deletion stamps deleted_rev; a client stamp is ignored; restore clears it', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    const del = await softDelete(db, id)
    let row = await one(db, 'select deleted_rev from public.transactions where id = $1', [id])
    expect(Number(row.deleted_rev)).toBe(Number(del.rev))
    // a pushed deleted_rev (a 1.0 echo of select *) never overrides the server's
    await db.query('update public.transactions set deleted_rev = 1, note = $2 where id = $1', [id, 'echo'])
    row = await one(db, 'select deleted_rev from public.transactions where id = $1', [id])
    expect(Number(row.deleted_rev)).toBe(Number(del.rev))
    await db.query(
      'update public.transactions set deleted_at = null, deleted_batch = null, base_rev = $2 where id = $1',
      [id, del.rev],
    )
    row = await one(db, 'select deleted_at, deleted_rev from public.transactions where id = $1', [id])
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_rev).toBeNull()
    // a row that arrives already in the bin (pushed by the device that binned it) is stamped too
    const ins = await one(
      db,
      `insert into public.transactions
         (id, kind, amount, currency, rate_usd, amount_usd, account_id, date, deleted_at, deleted_batch, deleted_rev)
       values ($1, 'expense', 10, 'USD', 1, 10, $2, '2026-10-25', now(), gen_random_uuid(), 5) returning rev, deleted_rev`,
      [newId(), ACCOUNT],
    )
    expect(Number(ins.deleted_rev)).toBe(Number(ins.rev))
    const plain = await insertTx1_0(db, newId())
    expect(plain.deleted_rev).toBeNull()
    for (const t of ['categories', 'transactions', 'goals', 'limits']) {
      const col = await db.query(
        `select 1 from information_schema.columns
         where table_schema = 'public' and table_name = $1 and column_name = 'deleted_rev' and data_type = 'bigint'`,
        [t],
      )
      expect(col.rows, t).toHaveLength(1)
    }
  })

  it('restore still works after an unrelated server write to the binned row', async () => {
    const id = newId()
    await insertTx1_0(db, id)
    const del = await softDelete(db, id)
    // another device's / the bot's write to the row while it sits in the bin
    const later = await one(db, `update public.transactions set note = 'bot' where id = $1 returning rev`, [id])
    expect(Number(later.rev)).toBeGreaterThan(Number(del.rev))
    // the restoring device saw the deletion (base_rev = the deletion's rev), not the later write
    const seen = toWire(await one(db, 'select * from public.transactions where id = $1', [id]))
    await upsertLikePostgrest(db, 'transactions', [
      { ...seen, note: 'bot', deleted_at: null, deleted_batch: null, base_rev: Number(del.rev) },
    ])
    const row = await one(db, 'select deleted_at, deleted_batch, deleted_rev from public.transactions where id = $1', [id])
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_batch).toBeNull()
    expect(row.deleted_rev).toBeNull()
  })

  it('a client that never saw the deletion still cannot resurrect it after later writes', async () => {
    const id = newId()
    const r1 = (await insertTx1_0(db, id)).rev
    const del = await softDelete(db, id)
    await db.query(`update public.transactions set note = 'bot' where id = $1`, [id])
    await db.query(
      'update public.transactions set deleted_at = null, deleted_batch = null, note = $3, base_rev = $2 where id = $1',
      [id, r1, 'stale'],
    )
    const row = await one(db, 'select deleted_at, deleted_batch, note from public.transactions where id = $1', [id])
    expect(time(row.deleted_at)).toBe(time(del.deleted_at))
    expect(row.deleted_batch).toBe(del.deleted_batch)
    expect(row.note).toBe('stale')
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
