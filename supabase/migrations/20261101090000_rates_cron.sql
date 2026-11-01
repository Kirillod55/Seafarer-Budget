-- Kirill's morning rates (2026-11-01): pg_cron calls the keepalive function every hour on the hour, and the function
-- answers only at 08:00 in settings.timezone, so the time follows him across time zones and summer time. GitHub's
-- schedule runs up to an hour late, this one does not. The token is generated here and never leaves the database:
-- cron reads it from the table, the function reads it with the service role, clients cannot.
create table public.cron_tokens (
  name  text primary key,
  value text not null
);
alter table public.cron_tokens enable row level security;
revoke all on public.cron_tokens from anon, authenticated;
grant select on public.cron_tokens to service_role;
insert into public.cron_tokens (name, value)
values ('rates', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

-- guarded: PGlite (supabase/sql.test.ts) has no pg_cron or pg_net
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    execute $job$
      select cron.schedule('morning-rates', '0 * * * *', $cmd$
        select net.http_post(
          url := 'https://qvhernqypfbototyisfr.supabase.co/functions/v1/keepalive?job=rates',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Cron-Token', (select value from public.cron_tokens where name = 'rates')
          ),
          body := '{}'::jsonb
        )
      $cmd$)
    $job$;
  end if;
end;
$$;
