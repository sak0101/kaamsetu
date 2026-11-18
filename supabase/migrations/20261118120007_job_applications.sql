-- KaamSetu Phase 1 / migration 07: job_applications

create table public.job_applications (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete cascade,
  worker_id     uuid not null references public.worker_profiles (user_id) on delete restrict,
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'rejected', 'withdrawn')),
  status_reason text check (status_reason is null or char_length(status_reason) <= 100),
  message       text check (message is null or char_length(message) <= 300),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint job_applications_job_worker_key unique (job_id, worker_id),
  constraint job_applications_id_job_worker_key unique (id, job_id, worker_id),
  constraint job_applications_pending_undecided check (status <> 'pending' or decided_at is null)
);

create index job_applications_job_status_idx    on public.job_applications (job_id, status);
create index job_applications_worker_status_idx on public.job_applications (worker_id, status);

alter table public.job_applications enable row level security;

-- State machine: pending -> accepted | rejected | withdrawn; withdrawn -> pending
-- (re-apply). accepted and rejected are terminal.
create function private.job_applications_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.job_id <> old.job_id or new.worker_id <> old.worker_id then
    raise exception 'application_identity_immutable' using errcode = 'KS409';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending'   and new.status in ('accepted', 'rejected', 'withdrawn'))
         or (old.status = 'withdrawn' and new.status = 'pending')) then
      raise exception 'invalid_application_transition' using errcode = 'KS409';
    end if;
  end if;
  return new;
end $$;

-- Notifications. The 'accepted' transition deliberately does NOT notify: the
-- worker is told once, via booking_confirmed, when the booking row is created.
create function private.job_applications_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = new.job_id;

  -- OLD is unassigned in INSERT triggers; branch on tg_op before touching it.
  if tg_op = 'INSERT' then
    perform private.notify(v_job.employer_id, 'new_application', 'job_application', new.id,
      jsonb_build_object('job_id', v_job.id, 'job_title', v_job.title));
  elsif new.status = 'pending' then        -- withdrawn -> pending (re-apply)
    perform private.notify(v_job.employer_id, 'new_application', 'job_application', new.id,
      jsonb_build_object('job_id', v_job.id, 'job_title', v_job.title));
  elsif new.status = 'rejected' then
    perform private.notify(new.worker_id, 'application_rejected', 'job_application', new.id,
      jsonb_build_object('job_id', v_job.id, 'job_title', v_job.title, 'reason', new.status_reason));
  end if;
  return null;
end $$;

create trigger trg_job_applications_10_guard
  before update on public.job_applications
  for each row execute function private.job_applications_guard();

create trigger trg_job_applications_90_updated_at
  before update on public.job_applications
  for each row execute function private.set_updated_at();

create trigger trg_job_applications_20_notify_ins
  after insert on public.job_applications
  for each row execute function private.job_applications_notify();

create trigger trg_job_applications_20_notify_upd
  after update of status on public.job_applications
  for each row when (old.status is distinct from new.status)
  execute function private.job_applications_notify();
