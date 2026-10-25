-- Seafarer Budget 1.1: every new column of 1.1 plus the "deletion wins" rules in set_rev().
-- Every new column is nullable or has a default, so 1.0 clients (app and bot), which never send
-- these columns, keep working: their inserts get the defaults and their upserts leave them alone.

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

  -- base_rev: the rev the client had seen when it made the edit. It carries no meaning of its own;
  -- only set_rev() reads it, and set_rev() clears it again on every UPDATE.
  foreach t in array array['settings', 'accounts', 'categories', 'transactions', 'goals', 'goal_moves', 'limits']
  loop
    execute format('alter table public.%I add column base_rev bigint', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_rev(): everything 1.0 did (commit-ordered rev, immutable user_id/id) plus two UPDATE rules.
-- One function serves all 7 synced tables, and only 4 of them have deleted_at, so the row is
-- read through jsonb for that column instead of naming new.deleted_at directly.
-- ---------------------------------------------------------------------------
create or replace function public.set_rev() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_j jsonb;
  new_j jsonb;
begin
  -- see init.sql: the advisory lock keeps rev visible in commit order
  perform pg_advisory_xact_lock(5201021000001);
  new.rev := nextval('public.rev_seq');
  if tg_op = 'UPDATE' then
    -- ownership and identity are immutable: an upsert can never move a row to another user
    new.user_id := old.user_id;
    new.id := old.id;

    -- Rule 1: `deleted = true` is the final deletion (after 24 h or "delete forever"); never undone.
    if old.deleted then
      new.deleted := true;
    end if;

    -- Rule 2: deletion wins over a stale edit. If the client edited a version older than the
    -- current one (base_rev < old.rev) and the row has since been soft-deleted on the server,
    -- a `deleted_at = null` in that edit is not a restore: keep the deletion, apply the rest.
    -- A client that had seen the deletion (base_rev >= old.rev) may restore.
    if new.base_rev is not null and new.base_rev < old.rev then
      old_j := to_jsonb(old);
      if old_j ? 'deleted_at' and old_j ->> 'deleted_at' is not null then
        new_j := to_jsonb(new);
        if new_j ->> 'deleted_at' is null then
          new := jsonb_populate_record(
            new,
            jsonb_build_object('deleted_at', old_j -> 'deleted_at', 'deleted_batch', old_j -> 'deleted_batch')
          );
        end if;
      end if;
    end if;

    -- base_rev is per request: never keep it, so a later write that omits it is not judged by it.
    new.base_rev := null;
  end if;
  return new;
end;
$$;

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
