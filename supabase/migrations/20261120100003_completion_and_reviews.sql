-- KaamSetu migration 15: booking completion, no-shows and reviews
--
-- finish_booking : the EMPLOYER marks a confirmed / in-progress booking `completed` or `no_show`, only after the
--                  job has started. Slot counters stay correct through the existing bookings triggers
--                  (completed keeps its slot; no_show releases it) and cancellation attribution is untouched.
-- submit_review  : either party of a COMPLETED booking rates the other side once (1 to 5, optional comment).
--                  A review can never exist without a completed booking between exactly those two people.
-- get_applicant_signals gains facts only: no_show_count, review_count, avg_rating. They are NULL / 0 for new
-- workers and are never used as a penalty (see apps/api/src/fit.ts).

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
create table public.booking_reviews (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete restrict,
  reviewer_id uuid not null references public.profiles (id) on delete restrict,
  reviewee_id uuid not null references public.profiles (id) on delete restrict,
  rating      smallint not null check (rating between 1 and 5),
  comment     text check (comment is null or char_length(comment) <= 300),
  created_at  timestamptz not null default now(),
  constraint booking_reviews_one_per_reviewer unique (booking_id, reviewer_id),
  constraint booking_reviews_not_self check (reviewer_id <> reviewee_id)
);
create index booking_reviews_reviewee_idx on public.booking_reviews (reviewee_id);
alter table public.booking_reviews enable row level security;

-- Backstop independent of the RPC: the booking must be completed and the two people must be exactly its worker and
-- employer. Reviews are immutable once written.
create function private.booking_reviews_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
begin
  if tg_op = 'UPDATE' then
    raise exception 'review_immutable' using errcode = 'KS409';
  end if;
  select * into v_b from public.bookings b where b.id = new.booking_id;
  if not found or v_b.status <> 'completed' then
    raise exception 'booking_not_completed' using errcode = 'KS409';
  end if;
  if not ((new.reviewer_id = v_b.worker_id and new.reviewee_id = v_b.employer_id)
       or (new.reviewer_id = v_b.employer_id and new.reviewee_id = v_b.worker_id)) then
    raise exception 'review_parties_invalid' using errcode = 'KS403';
  end if;
  return new;
end $$;

create trigger trg_booking_reviews_10_guard
  before insert or update on public.booking_reviews
  for each row execute function private.booking_reviews_guard();
create trigger trg_00_deny_client_writes before insert or update or delete
  on public.booking_reviews for each statement execute function private.deny_client_writes();

-- You can read the reviews you wrote and the reviews written about you. Nobody else.
create policy booking_reviews_select on public.booking_reviews for select to authenticated
  using (reviewer_id = (select auth.uid()) or reviewee_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- finish_booking: lock order job (X) -> booking (X), the same as cancel_booking.
-- ---------------------------------------------------------------------------
create function public.finish_booking(p_actor uuid, p_booking_id uuid, p_outcome text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job_id uuid;
  v_b      public.bookings%rowtype;
begin
  perform private.begin_api(p_actor, 'employer');

  if p_outcome is null or p_outcome not in ('completed', 'no_show') then
    raise exception 'invalid_outcome' using errcode = 'KS422';
  end if;

  select b.job_id into v_job_id from public.bookings b where b.id = p_booking_id and b.employer_id = p_actor;
  if not found then
    raise exception 'booking_not_found' using errcode = 'KS404';
  end if;

  perform 1 from public.jobs j where j.id = v_job_id for update;                    -- level 1
  select * into v_b from public.bookings b where b.id = p_booking_id for update;    -- level 4

  if v_b.status not in ('confirmed', 'in_progress') then
    raise exception 'booking_not_finishable' using errcode = 'KS409';
  end if;
  -- The booking state machine does not allow in_progress -> no_show (the worker did turn up); say so plainly.
  if p_outcome = 'no_show' and v_b.status = 'in_progress' then
    raise exception 'invalid_outcome' using errcode = 'KS422';
  end if;
  if now() < lower(v_b.work_period) then
    raise exception 'job_not_started' using errcode = 'KS409';
  end if;

  update public.bookings b
     set status       = p_outcome,
         completed_at = case when p_outcome = 'completed' then now() else null end
   where b.id = v_b.id;
end $$;

-- ---------------------------------------------------------------------------
-- submit_review
-- ---------------------------------------------------------------------------
create function public.submit_review(p_actor uuid, p_booking_id uuid, p_rating smallint, p_comment text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_b       public.bookings%rowtype;
  v_reviewee uuid;
  v_id      uuid;
begin
  perform private.begin_api(p_actor, null);

  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'invalid_rating' using errcode = 'KS422';
  end if;

  select * into v_b from public.bookings b
   where b.id = p_booking_id and p_actor in (b.worker_id, b.employer_id) for share;
  if not found then
    raise exception 'booking_not_found' using errcode = 'KS404';
  end if;
  if v_b.status <> 'completed' then
    raise exception 'booking_not_completed' using errcode = 'KS409';
  end if;
  if exists (select 1 from public.booking_reviews r where r.booking_id = v_b.id and r.reviewer_id = p_actor) then
    raise exception 'already_reviewed' using errcode = 'KS409';
  end if;

  v_reviewee := case when v_b.worker_id = p_actor then v_b.employer_id else v_b.worker_id end;
  insert into public.booking_reviews (booking_id, reviewer_id, reviewee_id, rating, comment)
  values (v_b.id, p_actor, v_reviewee, p_rating, nullif(left(btrim(coalesce(p_comment, '')), 300), ''))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Applicant evidence: add no-show and review facts (facts only; none of them is a score).
-- ---------------------------------------------------------------------------
drop function public.get_applicant_signals(uuid, uuid);

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
  has_booking_conflict boolean,
  bio                  text,
  skills               text[],
  availability_note    text,
  member_since         timestamptz,
  completed_jobs       integer,
  no_show_count        integer,
  review_count         integer,   -- reviews received from employers; 0 for every new worker
  avg_rating           numeric    -- null when there are no reviews: never treated as zero
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
                      and b.work_period && v_job.work_period),
           wp.bio, wp.skills, wp.availability_note, p.created_at,
           (select count(*)::int from public.bookings cb where cb.worker_id = a.worker_id and cb.status = 'completed'),
           (select count(*)::int from public.bookings nb where nb.worker_id = a.worker_id and nb.status = 'no_show'),
           (select count(*)::int from public.booking_reviews r where r.reviewee_id = a.worker_id),
           (select round(avg(r.rating), 1) from public.booking_reviews r where r.reviewee_id = a.worker_id)
      from public.job_applications a
      join public.profiles p         on p.id = a.worker_id
      join public.worker_profiles wp on wp.user_id = a.worker_id
     where a.job_id = p_job_id
     order by a.created_at, a.id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.finish_booking(uuid, uuid, text),
  public.submit_review(uuid, uuid, smallint, text),
  public.get_applicant_signals(uuid, uuid),
  private.booking_reviews_guard()
  from public, anon, authenticated, service_role;
-- Tables too: hosted default privileges can differ from local, so remove anything inherited before granting exactly what is needed.
revoke all on public.booking_reviews from public, anon, authenticated, service_role;
grant select on public.booking_reviews to authenticated;
grant execute on function
  public.finish_booking(uuid, uuid, text),
  public.submit_review(uuid, uuid, smallint, text),
  public.get_applicant_signals(uuid, uuid)
  to service_role;
