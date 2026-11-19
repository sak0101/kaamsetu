-- KaamSetu migration 13: jobs.duration_minutes
-- Additive and read-only: a generated column derived from starts_at / ends_at so the jobs API can filter
-- by duration on the server (PostgREST cannot compare two columns of the same row). Nothing is writable,
-- and `authenticated` already has table-level SELECT on public.jobs, so no grant change is needed.

alter table public.jobs
  add column duration_minutes integer
  generated always as ((extract(epoch from (ends_at - starts_at)) / 60)::integer) stored;

create index jobs_open_duration_idx on public.jobs (duration_minutes) where status = 'open';
