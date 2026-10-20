-- Seafarer Budget: schema, RLS, rev-based sync and realtime.
-- Column names/types mirror supabase/functions/_shared/types.ts field-for-field.
-- Sync model: every client pushes rows without `rev`/`user_id`; the server stamps
-- `rev` from one global sequence on every insert/update, and clients pull `rev > since`.

-- ---------------------------------------------------------------------------
-- rev sequence + trigger function
-- ---------------------------------------------------------------------------
create sequence public.rev_seq;

-- Runs as the caller (SECURITY INVOKER), so callers need USAGE on rev_seq (granted below).
--
-- Commit-ordered rev: a sequence hands out values at statement time, but rows become visible at
-- commit time. Without serialisation, writer A (rev 10) could commit after writer B (rev 11);
-- a client that already pulled rev 11 would then skip rev 10 forever. The transaction-level
-- advisory lock below is taken before nextval and held until commit/rollback, so concurrent
-- writers queue up and revs become visible in increasing order. Write volume is tiny (one user),
-- so the serialisation cost is irrelevant. The constant is an arbitrary fixed key for this app.
create function public.set_rev() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(5201021000001);
  new.rev := nextval('public.rev_seq');
  if tg_op = 'UPDATE' then
    -- ownership and identity are immutable: an upsert can never move a row to another user
    new.user_id := old.user_id;
    new.id := old.id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- synced tables (SYNC_TABLES in types.ts)
-- ---------------------------------------------------------------------------
create table public.settings (
  id                  uuid primary key,
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev                 bigint not null default nextval('public.rev_seq'),
  deleted             boolean not null default false,
  base_currency       text not null,
  default_currency    text not null,
  currencies          text[] not null,
  accounts_mode       text not null check (accounts_mode in ('single', 'multi')),
  status              text not null check (status in ('home', 'contract')),
  next_contract_date  date,
  contract_start_date date,
  contract_end_date   date,
  salary_lag_days     integer not null,
  timezone            text not null
);

create table public.accounts (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev        bigint not null default nextval('public.rev_seq'),
  deleted    boolean not null default false,
  name       text not null,
  aliases    text[] not null default '{}',
  is_default boolean not null default false,
  archived   boolean not null default false,
  sort       integer not null default 0
);

create table public.categories (
  id       uuid primary key,
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev      bigint not null default nextval('public.rev_seq'),
  deleted  boolean not null default false,
  name     text not null,
  kind     text not null check (kind in ('expense', 'income')),
  icon     text not null default '',
  keywords text[] not null default '{}',
  archived boolean not null default false,
  sort     integer not null default 0
);

create table public.transactions (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev           bigint not null default nextval('public.rev_seq'),
  deleted       boolean not null default false,
  kind          text not null check (kind in ('expense', 'income', 'transfer', 'exchange', 'adjustment')),
  amount        numeric not null,
  currency      text not null,
  rate_usd      numeric not null,
  amount_usd    numeric not null,
  rate_pending  boolean not null default false,
  account_id    uuid not null,
  to_account_id uuid,
  to_amount     numeric,
  to_currency   text,
  category_id   uuid,
  date          date not null,
  note          text not null default '',
  source        text not null default 'app' check (source in ('app', 'bot')),
  created_at    timestamptz not null default now()
);

create table public.goals (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev        bigint not null default nextval('public.rev_seq'),
  deleted    boolean not null default false,
  name       text not null,
  target_usd numeric not null,
  deadline   date,
  archived   boolean not null default false
);

create table public.goal_moves (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev        bigint not null default nextval('public.rev_seq'),
  deleted    boolean not null default false,
  goal_id    uuid not null,
  amount_usd numeric not null,
  date       date not null,
  note       text not null default ''
);

create table public.limits (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev         bigint not null default nextval('public.rev_seq'),
  deleted     boolean not null default false,
  category_id uuid not null,
  monthly_usd numeric not null
);

-- ---------------------------------------------------------------------------
-- shared FX rates (written only by the service role / Edge Function) and bot dedupe
-- ---------------------------------------------------------------------------
create table public.fx_rates (
  date         date not null,
  currency     text not null,
  uah_per_unit numeric not null,
  primary key (date, currency)
);

create table public.bot_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- per-table boilerplate for the synced tables: index, rev trigger, RLS, grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'accounts', 'categories', 'transactions', 'goals', 'goal_moves', 'limits']
  loop
    execute format('create index %I on public.%I (user_id, rev)', t || '_user_rev_idx', t);

    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.set_rev()',
      t || '_set_rev', t
    );

    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated '
      || 'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t
    );

    -- Be explicit regardless of the project's "auto-expose new tables" setting.
    -- No anon access. DELETE is allowed for the owner only (RLS owner_all); the app itself
    -- soft-deletes via `deleted` so deletions sync, hard delete is for cleanup (e.g. verify-db).
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- rev_seq is used by the column default and by the trigger, both evaluated as the caller.
grant usage on sequence public.rev_seq to authenticated, service_role;

-- Edge Functions (bot, fx-rates) use the service role: do not rely on auto-expose defaults.
grant all on
  public.settings,
  public.accounts,
  public.categories,
  public.transactions,
  public.goals,
  public.goal_moves,
  public.limits,
  public.fx_rates,
  public.bot_updates
to service_role;

-- fx_rates: read-only for signed-in users; writes only through the service role (bypasses RLS).
alter table public.fx_rates enable row level security;
create policy fx_rates_select on public.fx_rates for select to authenticated using (true);
revoke all on public.fx_rates from anon, authenticated;
grant select on public.fx_rates to authenticated;

-- bot_updates: RLS on, no policies, no grants -> service role only.
alter table public.bot_updates enable row level security;
revoke all on public.bot_updates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.settings,
  public.accounts,
  public.categories,
  public.transactions,
  public.goals,
  public.goal_moves,
  public.limits;
