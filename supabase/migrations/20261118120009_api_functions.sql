-- KaamSetu Phase 1 / migration 09: API functions (the ONLY write path).
--
-- Every function:
--   * is SECURITY DEFINER, owned by postgres, with search_path = '' (all objects
--     schema-qualified);
--   * takes the actor uid as p_actor. That is safe ONLY because EXECUTE is
--     granted to service_role alone (migration 10) and each function re-checks
--     the caller's JWT role claim. Express derives p_actor exclusively from a
--     successful auth.getUser(jwt);
--   * runs private.begin_api(): service-caller check, READ COMMITTED check, and
--     actor existence / suspension / role check;
--   * returns the same KS404 for "does not exist" and "is not yours" so IDs
--     cannot be probed.
--
-- ERROR CODES (SQLSTATE class 'KS'; message is a stable machine code):
--   KS401 unauthenticated   KS403 forbidden / wrong role / suspended
--   KS404 not found         KS409 state conflict   KS422 invalid input
--   KS500 unsupported isolation level
--
-- LOCK ORDER (global; no function ever acquires in a lower level after a higher one):
--   level 1  jobs row                (FOR UPDATE: accept, cancel_booking, cancel_job;
--                                     FOR SHARE : apply, withdraw, reject)
--   level 2  per-worker advisory lock (apply_to_job, accept_application ONLY: the
--                                     operations that can create a conflict)
--   level 3  job_applications rows   (several rows: ascending id)
--   level 4  bookings rows           (several rows: ascending id)
-- Per function:
--   apply_to_job          1(S) -> 2 -> 3
--   withdraw_application  1(S) -> 3
--   reject_application    1(S) -> 3
--   accept_application    1(X) -> 2 -> 3 -> insert 4
--   cancel_booking        1(X) -> 4
--   cancel_job            1(X) -> 3 (asc id) -> 4 (asc id)
-- Cancellations take no worker lock: they only REMOVE rows from the active set
-- and cannot create a conflict. A concurrent accept that misses the freed time
-- just returns a conservative worker_double_booked; retrying succeeds.

-- ---------------------------------------------------------------------------
-- Shared preamble
-- ---------------------------------------------------------------------------
create function private.require_active_user(p_actor uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_susp boolean;
begin
  if p_actor is null then
    raise exception 'unauthenticated' using errcode = 'KS401';
  end if;
  select p.role, p.is_suspended into v_role, v_susp from public.profiles p where p.id = p_actor;
  if not found then
    raise exception 'unauthenticated' using errcode = 'KS401';
  end if;
  if v_susp then
    raise exception 'account_suspended' using errcode = 'KS403';
  end if;
  if p_role is not null and v_role is distinct from p_role then
    raise exception 'wrong_role' using errcode = 'KS403';
  end if;
end $$;

create function private.begin_api(p_actor uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_caller();
  perform private.assert_read_committed();
  perform private.require_active_user(p_actor, p_role);
end $$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create function public.update_profile(
  p_actor uuid, p_full_name text, p_preferred_language text, p_org_name text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.begin_api(p_actor, null);
  update public.profiles p
     set full_name          = btrim(p_full_name),
         preferred_language = p_preferred_language,
         org_name           = case when p.role = 'employer' then nullif(btrim(p_org_name), '') else null end
   where p.id = p_actor;
end $$;

create function public.save_worker_profile(
  p_actor uuid, p_bio text, p_years_experience smallint, p_locality_id smallint,
  p_is_available boolean, p_category_ids smallint[] default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids smallint[];
begin
  perform private.begin_api(p_actor, 'worker');

  if p_locality_id is not null
     and not exists (select 1 from public.localities l where l.id = p_locality_id and l.is_active) then
    raise exception 'invalid_locality' using errcode = 'KS422';
  end if;

  if p_category_ids is not null then
    v_ids := array(select distinct x from unnest(p_category_ids) as x order by x);
    if cardinality(v_ids) > 5 then
      raise exception 'too_many_categories' using errcode = 'KS422';
    end if;
    if exists (select 1 from unnest(v_ids) as x
                where not exists (select 1 from public.work_categories c where c.id = x and c.is_active)) then
      raise exception 'invalid_category' using errcode = 'KS422';
    end if;
  end if;

  -- Serialise concurrent saves by the same worker (NO KEY UPDATE does not block
  -- foreign-key checks from bookings/applications).
  perform 1 from public.worker_profiles w where w.user_id = p_actor for no key update;

  update public.worker_profiles w
     set bio              = nullif(btrim(p_bio), ''),
         years_experience = p_years_experience,
         locality_id      = p_locality_id,
         is_available     = coalesce(p_is_available, true)
   where w.user_id = p_actor;

  if p_category_ids is not null then
    delete from public.worker_categories wc where wc.worker_id = p_actor;
    insert into public.worker_categories (worker_id, category_id)
      select p_actor, x from unnest(v_ids) as x;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create function public.create_job(
  p_actor uuid, p_category_id smallint, p_locality_id smallint, p_title text, p_description text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_workers_needed smallint,
  p_pay_type text, p_pay_amount_paise integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.begin_api(p_actor, 'employer');

  if p_starts_at is null or p_ends_at is null or p_starts_at <= now() then
    raise exception 'starts_at_must_be_future' using errcode = 'KS422';
  end if;
  if p_ends_at <= p_starts_at then
    raise exception 'ends_at_must_follow_starts_at' using errcode = 'KS422';
  end if;
  if not exists (select 1 from public.work_categories c where c.id = p_category_id and c.is_active) then
    raise exception 'invalid_category' using errcode = 'KS422';
  end if;
  if not exists (select 1 from public.localities l where l.id = p_locality_id and l.is_active) then
    raise exception 'invalid_locality' using errcode = 'KS422';
  end if;

  insert into public.jobs (employer_id, category_id, locality_id, title, description,
                           starts_at, ends_at, workers_needed, pay_type, pay_amount_paise)
  values (p_actor, p_category_id, p_locality_id, btrim(p_title), btrim(p_description),
          p_starts_at, p_ends_at, p_workers_needed, p_pay_type, p_pay_amount_paise)
  returning id into v_id;
  return v_id;
end $$;

-- cancel_job: 1(X) -> 3 (asc id) -> 4 (asc id)
create function public.cancel_job(p_actor uuid, p_job_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  perform private.begin_api(p_actor, 'employer');

  if not exists (select 1 from public.jobs j where j.id = p_job_id and j.employer_id = p_actor) then
    raise exception 'job_not_found' using errcode = 'KS404';
  end if;

  select * into v_job from public.jobs j where j.id = p_job_id for update;          -- level 1
  if v_job.status not in ('open', 'filled') then
    raise exception 'job_not_cancellable' using errcode = 'KS409';
  end if;

  -- Cancel the job FIRST so the slot trigger can never reopen it ('cancelled' is sticky).
  update public.jobs j
     set status = 'cancelled', cancelled_reason = coalesce(v_reason, 'cancelled_by_employer')
   where j.id = v_job.id;

  perform 1 from public.job_applications a                                          -- level 3
    where a.job_id = v_job.id and a.status = 'pending' order by a.id for update;
  update public.job_applications a
     set status = 'rejected', status_reason = 'job_cancelled', decided_at = now()
   where a.job_id = v_job.id and a.status = 'pending';

  perform 1 from public.bookings b                                                  -- level 4
    where b.job_id = v_job.id and b.status in ('confirmed', 'in_progress') order by b.id for update;
  update public.bookings b
     set status = 'cancelled_by_employer', cancelled_by = p_actor, cancelled_at = now(),
         cancel_reason = coalesce(v_reason, 'job_cancelled')
   where b.job_id = v_job.id and b.status in ('confirmed', 'in_progress');
end $$;

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------

-- apply_to_job: 1(S) -> 2 -> 3
create function public.apply_to_job(p_actor uuid, p_job_id uuid, p_message text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
  v_wp  public.worker_profiles%rowtype;
  v_id  uuid;
begin
  perform private.begin_api(p_actor, 'worker');

  select * into v_job from public.jobs j where j.id = p_job_id for share;           -- level 1
  if not found then
    raise exception 'job_not_found' using errcode = 'KS404';
  end if;

  perform private.lock_worker(p_actor);                                             -- level 2
  -- Everything below runs AFTER the lock (fresh snapshot per statement).
  perform private.require_active_user(p_actor, 'worker');

  if v_job.status <> 'open' or v_job.starts_at <= now() then
    raise exception 'job_not_open' using errcode = 'KS409';
  end if;

  select * into v_wp from public.worker_profiles w where w.user_id = p_actor;
  if not v_wp.is_available then
    raise exception 'worker_not_available' using errcode = 'KS409';
  end if;
  if v_wp.locality_id is null
     or not exists (select 1 from public.worker_categories wc where wc.worker_id = p_actor) then
    raise exception 'worker_profile_incomplete' using errcode = 'KS422';
  end if;

  if exists (select 1 from public.bookings b
              where b.worker_id = p_actor
                and b.status in ('confirmed', 'in_progress')
                and b.work_period && v_job.work_period) then
    raise exception 'worker_double_booked' using errcode = 'KS409';
  end if;

  if (select count(*) from public.job_applications a
       where a.worker_id = p_actor and a.status = 'pending') >= 20 then
    raise exception 'too_many_pending' using errcode = 'KS409';
  end if;

  insert into public.job_applications as a (job_id, worker_id, message)
  values (p_job_id, p_actor, nullif(btrim(p_message), ''))
  on conflict (job_id, worker_id) do update
     set status = 'pending', message = excluded.message, status_reason = null, decided_at = null
   where a.status = 'withdrawn'                                                     -- re-apply only
  returning a.id into v_id;

  if v_id is null then
    raise exception 'already_applied' using errcode = 'KS409';
  end if;
  return v_id;
end $$;

-- withdraw_application: 1(S) -> 3
create function public.withdraw_application(p_actor uuid, p_application_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job_id uuid;
  v_app public.job_applications%rowtype;
begin
  perform private.begin_api(p_actor, 'worker');

  select a.job_id into v_job_id from public.job_applications a
   where a.id = p_application_id and a.worker_id = p_actor;
  if not found then
    raise exception 'application_not_found' using errcode = 'KS404';
  end if;

  perform 1 from public.jobs j where j.id = v_job_id for share;                     -- level 1
  select * into v_app from public.job_applications a where a.id = p_application_id for update;  -- level 3
  if v_app.status <> 'pending' then
    raise exception 'application_not_pending' using errcode = 'KS409';
  end if;

  update public.job_applications a
     set status = 'withdrawn', status_reason = null, decided_at = now()
   where a.id = v_app.id;
end $$;

-- reject_application: 1(S) -> 3
create function public.reject_application(p_actor uuid, p_application_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job_id uuid;
  v_app public.job_applications%rowtype;
begin
  perform private.begin_api(p_actor, 'employer');

  select a.job_id into v_job_id
    from public.job_applications a join public.jobs j on j.id = a.job_id
   where a.id = p_application_id and j.employer_id = p_actor;
  if not found then
    raise exception 'application_not_found' using errcode = 'KS404';
  end if;

  perform 1 from public.jobs j where j.id = v_job_id for share;                     -- level 1
  select * into v_app from public.job_applications a where a.id = p_application_id for update;  -- level 3
  if v_app.status <> 'pending' then
    raise exception 'application_not_pending' using errcode = 'KS409';
  end if;

  update public.job_applications a
     set status = 'rejected',
         status_reason = coalesce(nullif(left(btrim(coalesce(p_reason, '')), 100), ''), 'employer_rejected'),
         decided_at = now()
   where a.id = v_app.id;
end $$;

-- ---------------------------------------------------------------------------
-- accept_application: the atomic booking transaction.
--   1(X) job -> 2 worker advisory lock -> 3 application -> insert booking (4)
-- Rollback: any exception aborts the whole function transaction, so a failure
-- leaves NO booking, the application still pending, job counters unchanged and
-- no notifications (they are trigger inserts in the same transaction). The inner
-- BEGIN..EXCEPTION is a savepoint that only translates exclusion_violation; the
-- re-raise then aborts everything.
-- ---------------------------------------------------------------------------
create function public.accept_application(p_actor uuid, p_application_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_job_id    uuid;
  v_worker_id uuid;
  v_job       public.jobs%rowtype;
  v_app       public.job_applications%rowtype;
  v_booking   uuid;
begin
  perform private.begin_api(p_actor, 'employer');

  -- Unlocked lookup only to learn which rows to lock. Unknown id and
  -- not-your-application are indistinguishable.
  select a.job_id, a.worker_id into v_job_id, v_worker_id
    from public.job_applications a join public.jobs j on j.id = a.job_id
   where a.id = p_application_id and j.employer_id = p_actor;
  if not found then
    raise exception 'application_not_found' using errcode = 'KS404';
  end if;

  select * into v_job from public.jobs j where j.id = v_job_id for update;          -- level 1
  perform private.lock_worker(v_worker_id);                                         -- level 2
  select * into v_app from public.job_applications a where a.id = p_application_id for update;  -- level 3

  -- All validation below is AFTER every lock.
  if v_app.status <> 'pending' then
    raise exception 'application_not_pending' using errcode = 'KS409';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'job_not_open' using errcode = 'KS409';
  end if;
  if v_job.status = 'filled' or v_job.positions_filled >= v_job.workers_needed then
    raise exception 'job_full' using errcode = 'KS409';
  end if;
  if v_job.starts_at <= now() then
    raise exception 'job_already_started' using errcode = 'KS409';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_worker_id and p.is_suspended) then
    raise exception 'worker_unavailable' using errcode = 'KS409';
  end if;
  if exists (select 1 from public.bookings b
              where b.worker_id = v_worker_id
                and b.status in ('confirmed', 'in_progress')
                and b.work_period && v_job.work_period) then
    raise exception 'worker_double_booked' using errcode = 'KS409';
  end if;

  -- Mark the application accepted BEFORE the booking exists, so nothing that
  -- runs afterwards can see it as pending.
  update public.job_applications a
     set status = 'accepted', status_reason = null, decided_at = now()
   where a.id = v_app.id;

  begin
    insert into public.bookings (job_id, application_id, worker_id, employer_id,
                                 work_period, agreed_pay_paise, status)
    values (v_job.id, v_app.id, v_worker_id, v_job.employer_id,
            v_job.work_period, v_job.pay_amount_paise, 'confirmed')
    returning id into v_booking;
    -- AFTER INSERT triggers (same transaction): positions_filled + 1, job -> 'filled'
    -- when full, booking_confirmed notification. They never touch applications.
  exception when exclusion_violation then
    raise exception 'worker_double_booked' using errcode = 'KS409';   -- final safeguard
  end;

  -- Explicit auto-reject, excluding the application just accepted.
  if exists (select 1 from public.jobs j where j.id = v_job.id and j.positions_filled >= j.workers_needed) then
    perform 1 from public.job_applications a
      where a.job_id = v_job.id and a.status = 'pending' and a.id <> v_app.id order by a.id for update;
    update public.job_applications a
       set status = 'rejected', status_reason = 'job_filled', decided_at = now()
     where a.job_id = v_job.id and a.status = 'pending' and a.id <> v_app.id;
  end if;

  return v_booking;
end $$;

-- ---------------------------------------------------------------------------
-- cancel_booking: 1(X) -> 4. No worker lock (cancellation cannot create a conflict).
-- Worker: only 'confirmed'. Employer: 'confirmed' or 'in_progress'. Not after the job ended.
-- ---------------------------------------------------------------------------
create function public.cancel_booking(p_actor uuid, p_booking_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job_id uuid;
  v_b      public.bookings%rowtype;
  v_new    text;
begin
  perform private.begin_api(p_actor, null);

  select b.job_id into v_job_id from public.bookings b
   where b.id = p_booking_id and p_actor in (b.worker_id, b.employer_id);
  if not found then
    raise exception 'booking_not_found' using errcode = 'KS404';
  end if;

  perform 1 from public.jobs j where j.id = v_job_id for update;                    -- level 1
  select * into v_b from public.bookings b where b.id = p_booking_id for update;    -- level 4

  if v_b.worker_id = p_actor then
    v_new := 'cancelled_by_worker';
    if v_b.status <> 'confirmed' then
      raise exception 'booking_not_cancellable' using errcode = 'KS409';
    end if;
  else
    v_new := 'cancelled_by_employer';
    if v_b.status not in ('confirmed', 'in_progress') then
      raise exception 'booking_not_cancellable' using errcode = 'KS409';
    end if;
  end if;
  if now() >= upper(v_b.work_period) then
    raise exception 'booking_already_ended' using errcode = 'KS409';
  end if;

  update public.bookings b
     set status = v_new, cancelled_by = p_actor, cancelled_at = now(),
         cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 200), '')
   where b.id = v_b.id;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications and applicant evidence
-- ---------------------------------------------------------------------------
create function public.mark_notifications_read(p_actor uuid, p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.begin_api(p_actor, null);
  with u as (
    update public.notifications n set read_at = now()
     where n.user_id = p_actor and n.read_at is null and (p_ids is null or n.id = any (p_ids))
    returning 1
  )
  select count(*)::int into v_count from u;
  return v_count;
end $$;

-- Phase 1 applicant evidence: facts only. No score, rating, reliability or
-- prediction. Ordering is by application time (neutral). The conflict flag is an
-- availability fact (an overlapping confirmed booking), not a quality signal.
create function public.get_applicant_signals(p_actor uuid, p_job_id uuid)
returns table (
  application_id       uuid,
  worker_id            uuid,
  worker_name          text,
  application_status   text,
  applied_at           timestamptz,
  message              text,
  category_match       boolean,
  locality_match       text,      -- same_locality | different_locality | unknown
  years_experience     smallint,  -- null = not provided
  has_booking_conflict boolean
)
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
begin
  perform private.begin_api(p_actor, 'employer');

  select * into v_job from public.jobs j where j.id = p_job_id and j.employer_id = p_actor;
  if not found then
    raise exception 'job_not_found' using errcode = 'KS404';
  end if;

  return query
    select a.id, a.worker_id, p.full_name, a.status, a.created_at, a.message,
           exists (select 1 from public.worker_categories wc
                    where wc.worker_id = a.worker_id and wc.category_id = v_job.category_id),
           case when wp.locality_id is null then 'unknown'
                when wp.locality_id = v_job.locality_id then 'same_locality'
                else 'different_locality' end,
           wp.years_experience,
           exists (select 1 from public.bookings b
                    where b.worker_id = a.worker_id
                      and b.status in ('confirmed', 'in_progress')
                      and b.work_period && v_job.work_period)
      from public.job_applications a
      join public.profiles p        on p.id = a.worker_id
      join public.worker_profiles wp on wp.user_id = a.worker_id
     where a.job_id = p_job_id
     order by a.created_at, a.id;
end $$;
