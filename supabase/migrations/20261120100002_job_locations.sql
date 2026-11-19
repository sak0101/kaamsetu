-- KaamSetu migration 14: job locations (privacy-safe, no coordinates, no maps API)
--
-- The exact address lives in its OWN table because public.jobs is readable by every worker (open jobs).
-- Who can read a job's address:
--   * the employer who owns the job;
--   * a worker with a LIVE booking on it (confirmed / in_progress) whose work period has not ended.
-- Applicants, other workers, other employers and anon can never read it. The locality stays public on the job.
-- Writes: only through save_job_location (service_role), like every other mutation.

create table public.job_locations (
  job_id       uuid primary key references public.jobs (id) on delete cascade,
  address_line text not null check (char_length(btrim(address_line)) between 5 and 200),
  landmark     text check (landmark is null or char_length(btrim(landmark)) between 1 and 100),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.job_locations enable row level security;

create trigger trg_job_locations_90_updated_at
  before update on public.job_locations
  for each row execute function private.set_updated_at();
create trigger trg_00_deny_client_writes before insert or update or delete
  on public.job_locations for each statement execute function private.deny_client_writes();

-- A booking that is still live: confirmed or in progress, and the job has not ended yet.
create function private.has_live_booking_on_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.bookings b
     where b.job_id = p_job
       and b.worker_id = (select auth.uid())
       and b.status in ('confirmed', 'in_progress')
       and upper(b.work_period) > now()
  );
$$;

create policy job_locations_select on public.job_locations for select to authenticated
  using (private.owns_job(job_id) or private.has_live_booking_on_job(job_id));

-- Employer sets (or, with a blank address, clears) the address of one of their own jobs.
create function public.save_job_location(
  p_actor uuid, p_job_id uuid, p_address_line text, p_landmark text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs%rowtype;
  v_addr text := btrim(coalesce(p_address_line, ''));
  v_mark text := nullif(btrim(coalesce(p_landmark, '')), '');
begin
  perform private.begin_api(p_actor, 'employer');

  -- Same KS404 for "no such job" and "not your job" so ids cannot be probed.
  select * into v_job from public.jobs j where j.id = p_job_id and j.employer_id = p_actor for share;  -- lock level 1
  if not found then
    raise exception 'job_not_found' using errcode = 'KS404';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'job_not_editable' using errcode = 'KS409';
  end if;

  if v_addr = '' then
    delete from public.job_locations l where l.job_id = p_job_id;
    return;
  end if;
  if char_length(v_addr) not between 5 and 200 or (v_mark is not null and char_length(v_mark) > 100) then
    raise exception 'invalid_location' using errcode = 'KS422';
  end if;

  insert into public.job_locations as l (job_id, address_line, landmark)
  values (p_job_id, v_addr, v_mark)
  on conflict (job_id) do update set address_line = excluded.address_line, landmark = excluded.landmark;
end $$;

-- Grants (same model as migrations 10 and 12): start from nothing, then grant exactly what is needed.
revoke all on function public.save_job_location(uuid, uuid, text, text), private.has_live_booking_on_job(uuid)
  from public, anon, authenticated, service_role;
-- Tables too: hosted default privileges can differ from local, so remove anything inherited before granting exactly what is needed.
revoke all on public.job_locations from public, anon, authenticated, service_role;
grant select on public.job_locations to authenticated;
grant execute on function private.has_live_booking_on_job(uuid) to authenticated;
grant execute on function public.save_job_location(uuid, uuid, text, text) to service_role;
