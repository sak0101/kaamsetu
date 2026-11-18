-- KaamSetu Phase 1b / migration 12
-- Worker skills + availability note, optional contact phone (shared only with an
-- actively booked counterpart), richer applicant evidence.
-- Never collected: Aadhaar, ID numbers, date of birth, gender, home address.

-- ---------------------------------------------------------------------------
-- Worker profile extras
-- ---------------------------------------------------------------------------
create function private.skills_valid(p_skills text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(p_skills) <= 8
     and not exists (select 1 from unnest(p_skills) s where char_length(s) not between 2 and 40);
$$;

alter table public.worker_profiles
  add column skills text[] not null default '{}',
  add column availability_note text,
  add constraint worker_profiles_skills_check check (private.skills_valid(skills)),
  add constraint worker_profiles_availability_note_check
    check (availability_note is null or char_length(availability_note) <= 120);

-- Replace save_worker_profile with a version that also saves skills and the availability note.
-- p_skills NULL leaves the stored skills unchanged (like p_category_ids); the note is overwritten.
drop function public.save_worker_profile(uuid, text, smallint, smallint, boolean, smallint[]);

create function public.save_worker_profile(
  p_actor uuid, p_bio text, p_years_experience smallint, p_locality_id smallint,
  p_is_available boolean, p_category_ids smallint[] default null,
  p_skills text[] default null, p_availability_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids    smallint[];
  v_skills text[];
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

  if p_skills is not null then
    -- trim, drop blanks, de-duplicate case-insensitively (keep first spelling), preserve order
    v_skills := coalesce(array(
      select d.s from (
        select distinct on (lower(btrim(t.x))) btrim(t.x) as s, t.ord
          from unnest(p_skills) with ordinality as t(x, ord)
         where btrim(t.x) <> ''
         order by lower(btrim(t.x)), t.ord
      ) d order by d.ord
    ), '{}');
    if not private.skills_valid(v_skills) then
      raise exception 'invalid_skills' using errcode = 'KS422';
    end if;
  end if;

  perform 1 from public.worker_profiles w where w.user_id = p_actor for no key update;

  update public.worker_profiles w
     set bio               = nullif(btrim(p_bio), ''),
         years_experience  = p_years_experience,
         locality_id       = p_locality_id,
         is_available      = coalesce(p_is_available, true),
         skills            = coalesce(v_skills, w.skills),
         availability_note = nullif(btrim(coalesce(p_availability_note, '')), '')
   where w.user_id = p_actor;

  if p_category_ids is not null then
    delete from public.worker_categories wc where wc.worker_id = p_actor;
    insert into public.worker_categories (worker_id, category_id)
      select p_actor, x from unnest(v_ids) as x;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Contact phone (optional). Indian mobile numbers only; stored as +91XXXXXXXXXX.
-- ---------------------------------------------------------------------------
create table public.contact_details (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  phone      text not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.contact_details enable row level security;

create trigger trg_contact_details_90_updated_at
  before update on public.contact_details
  for each row execute function private.set_updated_at();
create trigger trg_00_deny_client_writes before insert or update or delete
  on public.contact_details for each statement execute function private.deny_client_writes();

-- The caller and `p_other` are the two sides of a booking that is still live.
create function private.has_active_booking_with(p_other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.bookings b
     where b.status in ('confirmed', 'in_progress')
       and ((b.worker_id = (select auth.uid()) and b.employer_id = p_other)
         or (b.employer_id = (select auth.uid()) and b.worker_id = p_other))
  );
$$;

create policy contact_details_select on public.contact_details for select to authenticated
  using (user_id = (select auth.uid()) or private.has_active_booking_with(user_id));

create function public.save_contact(p_actor uuid, p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digits text;
  v_phone  text;
begin
  perform private.begin_api(p_actor, null);
  if p_phone is null or btrim(p_phone) = '' then
    delete from public.contact_details c where c.user_id = p_actor;     -- clearing the number
    return;
  end if;
  v_digits := regexp_replace(p_phone, '[\s().-]', '', 'g');
  v_phone := case
    when v_digits ~ '^\+91[6-9][0-9]{9}$' then v_digits
    when v_digits ~ '^91[6-9][0-9]{9}$'   then '+' || v_digits
    when v_digits ~ '^0?[6-9][0-9]{9}$'   then '+91' || right(v_digits, 10)
    else null end;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = 'KS422';
  end if;
  insert into public.contact_details as c (user_id, phone) values (p_actor, v_phone)
  on conflict (user_id) do update set phone = excluded.phone;
end $$;

-- ---------------------------------------------------------------------------
-- Richer applicant evidence. Facts only: still no score, rating or prediction.
-- completed_jobs counts genuinely completed bookings (0 for every new worker; nothing is inferred).
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
  completed_jobs       integer
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
           (select count(*)::int from public.bookings cb where cb.worker_id = a.worker_id and cb.status = 'completed')
      from public.job_applications a
      join public.profiles p         on p.id = a.worker_id
      join public.worker_profiles wp on wp.user_id = a.worker_id
     where a.job_id = p_job_id
     order by a.created_at, a.id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants (same model as migration 10)
-- ---------------------------------------------------------------------------
-- New functions get default EXECUTE; start from nothing (as migration 10 does), then grant exactly what is needed.
revoke all on function
  public.save_worker_profile(uuid, text, smallint, smallint, boolean, smallint[], text[], text),
  public.save_contact(uuid, text),
  public.get_applicant_signals(uuid, uuid),
  private.skills_valid(text[]),
  private.has_active_booking_with(uuid)
  from public, anon, authenticated, service_role;
grant select on public.contact_details to authenticated;
grant execute on function private.has_active_booking_with(uuid) to authenticated;
grant execute on function
  public.save_worker_profile(uuid, text, smallint, smallint, boolean, smallint[], text[], text),
  public.save_contact(uuid, text),
  public.get_applicant_signals(uuid, uuid)
  to service_role;
