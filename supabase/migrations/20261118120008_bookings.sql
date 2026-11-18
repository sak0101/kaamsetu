-- KaamSetu Phase 1 / migration 08: bookings
--
-- Statuses (the full set is declared now so later phases need no CHECK change;
-- Phase 1 functions only produce confirmed, cancelled_by_worker and
-- cancelled_by_employer):
--   confirmed, in_progress, completed,
--   cancelled_by_worker, cancelled_by_employer, cancelled_by_admin, no_show
--
-- Slot-occupying  : confirmed, in_progress, completed
-- Overlap-blocking: confirmed, in_progress   (active states only)

create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null,
  application_id   uuid not null unique,
  worker_id        uuid not null references public.worker_profiles (user_id) on delete restrict,
  employer_id      uuid not null,
  work_period      tstzrange not null check (not isempty(work_period)),
  agreed_pay_paise integer not null check (agreed_pay_paise > 0),
  status           text not null default 'confirmed' check (status in
    ('confirmed', 'in_progress', 'completed',
     'cancelled_by_worker', 'cancelled_by_employer', 'cancelled_by_admin', 'no_show')),
  cancelled_by     uuid references public.profiles (id) on delete restrict,
  cancelled_at     timestamptz,
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- The denormalised employer_id / worker_id can never drift from job / application.
  constraint bookings_job_employer_fk
    foreign key (job_id, employer_id) references public.jobs (id, employer_id) on delete restrict,
  constraint bookings_application_fk
    foreign key (application_id, job_id, worker_id)
    references public.job_applications (id, job_id, worker_id) on delete restrict,
  constraint bookings_job_worker_key unique (job_id, worker_id),

  -- Cancellation attribution: the label must match the actor, so an
  -- employer/admin-caused cancellation can never be recorded as worker-caused.
  constraint bookings_cancel_fields check (
    case when status like 'cancelled%'
         then cancelled_by is not null and cancelled_at is not null
         else cancelled_by is null and cancelled_at is null end),
  constraint bookings_cancel_worker_actor   check (status <> 'cancelled_by_worker'   or cancelled_by = worker_id),
  constraint bookings_cancel_employer_actor check (status <> 'cancelled_by_employer' or cancelled_by = employer_id),
  constraint bookings_completed_fields check ((status = 'completed') = (completed_at is not null)),

  -- FINAL safeguard against overlapping active bookings for one worker.
  -- Half-open ranges: back-to-back jobs (end = next start) do not conflict.
  -- completed / cancelled_* / no_show are outside the predicate and never block.
  constraint bookings_no_worker_overlap exclude using gist
    (worker_id with =, work_period with &&)
    where (status in ('confirmed', 'in_progress'))
);

create index bookings_worker_status_idx   on public.bookings (worker_id, status);
create index bookings_employer_status_idx on public.bookings (employer_id, status);
create index bookings_job_idx             on public.bookings (job_id);

alter table public.bookings enable row level security;

-- ---------------------------------------------------------------------------
-- Trigger order (alphabetical within each timing):
--   BEFORE INSERT : trg_bookings_10_before_insert  (lock worker, validate job)
--   BEFORE UPDATE : trg_bookings_10_guard          (immutability, state machine)
--                   trg_bookings_90_updated_at
--   AFTER  INSERT/UPDATE OF status:
--                   trg_bookings_10_sync_slots     (positions_filled delta, job status)
--                   trg_bookings_20_notify
-- Nothing here touches job_applications: auto-rejection is explicit in
-- accept_application / cancel_job, so the accepted application can never be
-- rejected as a side effect of the slot counter.
-- ---------------------------------------------------------------------------

create function private.bookings_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
begin
  -- Backstop: re-entrant if the API function already holds it.
  perform private.lock_worker(new.worker_id);

  if new.status <> 'confirmed' then
    raise exception 'booking_must_start_confirmed' using errcode = 'KS409';
  end if;
  select * into v_job from public.jobs where id = new.job_id;
  if not found or v_job.status <> 'open' then
    raise exception 'job_not_open' using errcode = 'KS409';
  end if;
  if new.work_period is distinct from v_job.work_period then
    raise exception 'booking_period_mismatch' using errcode = 'KS409';
  end if;
  return new;
end $$;

-- State machine.
--   confirmed   -> in_progress | completed | cancelled_by_worker | cancelled_by_employer
--                  | cancelled_by_admin | no_show
--   in_progress -> completed | cancelled_by_employer | cancelled_by_admin
--   no_show     -> cancelled_by_admin   (admin reversal)
-- completed and cancelled_* are terminal.
create function private.bookings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.job_id <> old.job_id or new.application_id <> old.application_id
     or new.worker_id <> old.worker_id or new.employer_id <> old.employer_id
     or new.work_period <> old.work_period or new.agreed_pay_paise <> old.agreed_pay_paise then
    raise exception 'booking_immutable' using errcode = 'KS409';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'confirmed' and new.status in
            ('in_progress', 'completed', 'cancelled_by_worker', 'cancelled_by_employer',
             'cancelled_by_admin', 'no_show'))
      or (old.status = 'in_progress' and new.status in
            ('completed', 'cancelled_by_employer', 'cancelled_by_admin'))
      or (old.status = 'no_show' and new.status = 'cancelled_by_admin')
    ) then
      raise exception 'invalid_booking_transition' using errcode = 'KS409';
    end if;
  end if;
  return new;
end $$;

-- Slot counter. Uses DELTAS, not a recount: `UPDATE ... SET x = (SELECT count(*))`
-- would evaluate its subselect against the statement-start snapshot and could
-- undercount after a lock wait, whereas `x = x + delta` is re-evaluated against
-- the latest committed row version. The CHECK on jobs rejects any result that
-- would be negative or above workers_needed.
create function private.bookings_sync_slots() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_occ boolean := false;
  v_new_occ boolean := new.status in ('confirmed', 'in_progress', 'completed');
  v_delta   integer;
begin
  -- OLD is unassigned in INSERT triggers; never reference it outside this branch.
  if tg_op = 'UPDATE' then
    v_old_occ := old.status in ('confirmed', 'in_progress', 'completed');
  end if;
  v_delta := v_new_occ::int - v_old_occ::int;

  if v_delta <> 0 then
    update public.jobs j
       set positions_filled = j.positions_filled + v_delta,
           status = case
             when j.status = 'open'
                  and j.positions_filled + v_delta >= j.workers_needed then 'filled'
             when j.status = 'filled'
                  and j.positions_filled + v_delta < j.workers_needed
                  and j.starts_at > now() then 'open'
             else j.status                      -- 'cancelled' never reopens
           end
     where j.id = new.job_id;
  end if;
  return null;
end $$;

create function private.bookings_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_title text;
  v_payload jsonb;
begin
  select title into v_title from public.jobs where id = new.job_id;
  v_payload := jsonb_build_object('job_id', new.job_id, 'job_title', v_title, 'booking_id', new.id);

  if tg_op = 'INSERT' then
    perform private.notify(new.worker_id, 'booking_confirmed', 'booking', new.id, v_payload);
  elsif new.status = 'cancelled_by_worker' then
    perform private.notify(new.employer_id, 'booking_cancelled', 'booking', new.id,
      v_payload || '{"cancelled_by":"worker"}');
  elsif new.status = 'cancelled_by_employer' then
    perform private.notify(new.worker_id, 'booking_cancelled', 'booking', new.id,
      v_payload || '{"cancelled_by":"employer"}');
  elsif new.status = 'cancelled_by_admin' then
    perform private.notify(new.worker_id, 'booking_cancelled', 'booking', new.id,
      v_payload || '{"cancelled_by":"admin"}');
    perform private.notify(new.employer_id, 'booking_cancelled', 'booking', new.id,
      v_payload || '{"cancelled_by":"admin"}');
  end if;
  return null;
end $$;

create trigger trg_bookings_10_before_insert
  before insert on public.bookings
  for each row execute function private.bookings_before_insert();

create trigger trg_bookings_10_guard
  before update on public.bookings
  for each row execute function private.bookings_guard();

create trigger trg_bookings_90_updated_at
  before update on public.bookings
  for each row execute function private.set_updated_at();

create trigger trg_bookings_10_sync_slots_ins
  after insert on public.bookings
  for each row execute function private.bookings_sync_slots();

create trigger trg_bookings_10_sync_slots_upd
  after update of status on public.bookings
  for each row when (old.status is distinct from new.status)
  execute function private.bookings_sync_slots();

create trigger trg_bookings_20_notify_ins
  after insert on public.bookings
  for each row execute function private.bookings_notify();

create trigger trg_bookings_20_notify_upd
  after update of status on public.bookings
  for each row when (old.status is distinct from new.status)
  execute function private.bookings_notify();
