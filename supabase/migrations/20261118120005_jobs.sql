-- KaamSetu Phase 1 / migration 05: jobs
-- Money is integer paise (INR only). Timestamps are timestamptz (UTC); the app
-- displays them in Asia/Kolkata.
-- Status: open | filled | cancelled. "Expired" / "in progress" / "completed" are
-- derived from time + bookings; correctness never depends on a background job
-- (every function and policy tests starts_at > now()).

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  employer_id      uuid not null,
  employer_role    text generated always as ('employer') stored,
  category_id      smallint not null references public.work_categories (id) on delete restrict,
  locality_id      smallint not null references public.localities (id) on delete restrict,
  title            text not null check (char_length(btrim(title)) between 5 and 100),
  description      text not null check (char_length(btrim(description)) between 1 and 1000),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  work_period      tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  workers_needed   smallint not null check (workers_needed between 1 and 50),
  pay_type         text not null check (pay_type in ('daily', 'hourly', 'fixed')),
  pay_amount_paise integer not null check (pay_amount_paise > 0 and pay_amount_paise <= 5000000), -- <= INR 50,000
  status           text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  positions_filled smallint not null default 0,
  cancelled_reason text check (cancelled_reason is null or char_length(cancelled_reason) <= 200),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint jobs_employer_fk
    foreign key (employer_id, employer_role) references public.profiles (id, role) on delete restrict,
  constraint jobs_id_employer_key unique (id, employer_id),
  constraint jobs_period_check check (ends_at > starts_at and ends_at - starts_at <= interval '14 days'),
  -- Hard backstop: positions can never go negative or exceed capacity.
  constraint jobs_positions_check check (positions_filled >= 0 and positions_filled <= workers_needed)
);

create index jobs_open_locality_start_idx on public.jobs (locality_id, starts_at) where status = 'open';
create index jobs_open_category_start_idx on public.jobs (category_id, starts_at) where status = 'open';
create index jobs_employer_status_idx     on public.jobs (employer_id, status);

alter table public.jobs enable row level security;

create function private.jobs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.employer_id <> old.employer_id then
    raise exception 'job_owner_immutable' using errcode = 'KS403';
  end if;
  return new;
end $$;

create trigger trg_jobs_10_guard
  before update on public.jobs
  for each row execute function private.jobs_guard();

create trigger trg_jobs_90_updated_at
  before update on public.jobs
  for each row execute function private.set_updated_at();
