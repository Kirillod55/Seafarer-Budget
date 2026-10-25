-- Seafarer Budget 1.1: every new column of 1.1 plus the deletion and NULL-fill rules in set_rev().
--
-- 1.0 clients keep working after this migration, but note how they talk to the server: they pull
-- `select('*')`, keep every column in Dexie and push the whole row back (without rev/user_id), in
-- PostgREST multi-row upserts whose key set is the union of all rows (a missing key goes as NULL).
-- So after the migration a 1.0 client DOES send the 1.1 columns: echoed as pulled, or as NULL
-- when another row in the same batch has them. Hence:
--   * every new column is nullable or has a default (a fresh 1.0 row that omits it gets the default);
--   * set_rev() turns NULLs in the NOT NULL 1.1 columns into the default (new row) or the stored
--     value (existing row), before the constraints are checked;
--   * set_rev() keeps a soft deletion unless the writer proves it saw it (base_rev = current rev).

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
alter table public.settings
  add column reserve_usd           numeric not null default 0 check (reserve_usd >= 0),
  add column partner_name          text,
  add column partner_seen_at       timestamptz,
  add column remind_after_days     integer not null default 2 check (remind_after_days in (0, 2, 3, 5, 7)),
  add column last_reminder_at      timestamptz,
  add column keepalive_at          timestamptz,
  add column daily_summary_owner   boolean not null default false,
  add column daily_summary_partner boolean not null default false;

-- ---------------------------------------------------------------------------
-- transactions, goal_moves: who made the row
-- ---------------------------------------------------------------------------
alter table public.transactions
  add column author   text not null default 'owner' check (author in ('owner', 'partner')),
  add column archived boolean not null default false;

alter table public.goal_moves
  add column author     text not null default 'owner' check (author in ('owner', 'partner')),
  add column source     text not null default 'app' check (source in ('app', 'bot')),
  add column created_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- categories: interface colour and glyph. `icon` (1.0) keeps the bot's emoji; `glyph` is the
-- interface icon key (one of 18: cart, coffee, car, home, wifi, health, ticket, doc, gift, plane,
-- shirt, book, fuel, gym, phone, wallet, box, tag). Not constrained here: the app owns that list.
-- ---------------------------------------------------------------------------
alter table public.categories
  add column color text,
  add column glyph text;

-- ---------------------------------------------------------------------------
-- soft delete with 24 h undo (deleted_at / deleted_batch) and base_rev on synced tables
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- deleted_at: when the row went to the 24 h undo bin; deleted_batch: one id per delete action
  -- (a whole "delete period" restores together). `deleted = true` stays the final deletion.
  foreach t in array array['transactions', 'goals', 'limits', 'categories']
  loop
    execute format('alter table public.%I add column deleted_at timestamptz, add column deleted_batch uuid', t);
  end loop;

  -- base_rev: the rev the writer had seen when it made the edit. It carries no meaning of its own;
  -- only set_rev() reads it, and set_rev() clears it again on every UPDATE.
  foreach t in array array['settings', 'accounts', 'categories', 'transactions', 'goals', 'goal_moves', 'limits']
  loop
    execute format('alter table public.%I add column base_rev bigint', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_rev(): everything 1.0 did (commit-ordered rev, immutable user_id/id) plus:
--   INSERT  NULL in a NOT NULL 1.1 column -> its default, or the stored value if the id exists (upsert)
--   UPDATE  rule 1: `deleted = true` is final and never undone
--           NULL in a 1.1 column -> the stored value (a 1.0 batch upsert sends missing keys as NULL)
--           rule 2: a soft deletion (deleted_at) is kept unless base_rev = old.rev
--           base_rev is cleared (it only counts for the request that sent it)
-- One function serves all 7 synced tables and the 1.1 columns exist only on some of them, so the
-- row is read through jsonb and patched with jsonb_populate_record instead of naming new.<col>.
-- ---------------------------------------------------------------------------
create or replace function public.set_rev() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_j    jsonb;
  new_j    jsonb;
  patch    jsonb := '{}';
  defaults jsonb;
  keep     text[];
  k        text;
  stored   jsonb;
begin
  -- see init.sql: the advisory lock keeps rev visible in commit order
  perform pg_advisory_xact_lock(5201021000001);
  new.rev := nextval('public.rev_seq');

  if tg_op = 'INSERT' then
    defaults := case tg_table_name
      when 'transactions' then jsonb_build_object('author', 'owner', 'archived', false)
      when 'goal_moves'   then jsonb_build_object('author', 'owner', 'source', 'app', 'created_at', now())
    end;
    if defaults is not null then
      -- An upsert runs this INSERT trigger on the proposed row before it finds the conflict; NOT NULL
      -- is checked on that row right after (so the NULL cannot be left for the UPDATE step), and
      -- EXCLUDED is that row as this trigger leaves it. A default here would then overwrite the
      -- stored value of an existing row (author 'partner' -> 'owner'). So: an id that already
      -- exists gets its stored value, a new id gets the default.
      execute format('select to_jsonb(t) from %I.%I t where t.id = $1', tg_table_schema, tg_table_name)
        into stored using new.id;
      new_j := to_jsonb(new);
      for k in select jsonb_object_keys(defaults) loop
        if new_j -> k = 'null'::jsonb then
          patch := patch || jsonb_build_object(k, coalesce(stored -> k, defaults -> k));
        end if;
      end loop;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- ownership and identity are immutable: an upsert can never move a row to another user
    new.user_id := old.user_id;
    new.id := old.id;

    -- Rule 1: `deleted = true` is the final deletion (after 24 h or "delete forever"); never undone.
    if old.deleted then
      new.deleted := true;
    end if;

    old_j := to_jsonb(old);
    new_j := to_jsonb(new);

    -- NULL in a 1.1 column keeps the stored value.
    keep := case tg_table_name
      when 'transactions' then array['author', 'archived']
      when 'goal_moves'   then array['author', 'source', 'created_at']
      when 'categories'   then array['color', 'glyph']
      else array[]::text[]
    end;
    foreach k in array keep loop
      if new_j -> k = 'null'::jsonb then
        patch := patch || jsonb_build_object(k, old_j -> k);
      end if;
    end loop;

    -- Rule 2: deletion wins. A soft-deleted row (deleted_at set) is restored only by a writer that
    -- saw the deletion: base_rev = the current rev. A missing base_rev (every 1.0 client, any echo
    -- of a stale pulled row) or an older one keeps deleted_at/deleted_batch; the rest of the edit
    -- still applies.
    if old_j -> 'deleted_at' is not null and old_j -> 'deleted_at' <> 'null'::jsonb
       and new_j -> 'deleted_at' = 'null'::jsonb
       and (new.base_rev is null or new.base_rev < old.rev) then
      patch := patch || jsonb_build_object('deleted_at', old_j -> 'deleted_at', 'deleted_batch', old_j -> 'deleted_batch');
    end if;

    -- base_rev is per request: never keep it, so a later write that omits it is not judged by it.
    new.base_rev := null;
  end if;

  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- goal_moves.created_at backfill: existing moves get noon UTC of their own date instead of the
-- migration time (the same value the app's Dexie upgrade uses). The UPDATE goes through set_rev(),
-- so these rows get a new rev and every device pulls the backfilled value.
-- ---------------------------------------------------------------------------
update public.goal_moves set created_at = (date + time '12:00') at time zone 'UTC';

-- ---------------------------------------------------------------------------
-- Supabase adds public.rls_auto_enable() to live projects (it is not in our migrations).
-- Clients have no business calling it. Guarded so the migration also applies where it is absent.
-- ---------------------------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
