-- KaamSetu Phase 1 / migration 11: Realtime publication.
-- Postgres Changes enforces each subscriber's SELECT policies. `jobs` is
-- intentionally not published (per-change RLS cost; the job list refetches).
-- No hard deletes of these rows are exposed, so the "DELETE events bypass RLS"
-- caveat does not apply. Payloads carry no phone numbers or addresses.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime
  add table public.job_applications, public.bookings, public.notifications;
