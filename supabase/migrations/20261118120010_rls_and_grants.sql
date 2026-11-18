-- KaamSetu Phase 1 / migration 10: RLS policies, grants, backstops.
--
-- MODEL
--   anon          : nothing.
--   authenticated : SELECT only, under RLS (browser reads + Realtime).
--                   No INSERT/UPDATE/DELETE grants, no write policies, no
--                   EXECUTE on any API function.
--   service_role  : EXECUTE on the 11 API functions ONLY. No table privileges at
--                   all (not even SELECT): reads happen through the user's own
--                   JWT under RLS, or through functions.
--   owner postgres: definer functions run as the owner; RLS is ENABLED, not
--                   FORCED, so they bypass it as intended.

-- ---------------------------------------------------------------------------
-- RLS helper functions. SECURITY DEFINER so they can read tables the caller
-- cannot, and so cross-table policy checks cannot recurse through each other's
-- policies. They only ever look at the caller's own identity (auth.uid()).
-- ---------------------------------------------------------------------------
create function private.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

create function private.owns_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.jobs j
                  where j.id = p_job and j.employer_id = (select auth.uid()));
$$;

create function private.has_applied(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.job_applications a
                  where a.job_id = p_job and a.worker_id = (select auth.uid()));
$$;

create function private.has_booking_on_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bookings b
                  where b.job_id = p_job
                    and (select auth.uid()) in (b.worker_id, b.employer_id));
$$;

-- May the caller see this user's profile data?
--   self | linked through an application or booking | a worker looking at an
--   employer who currently has an open, future job.
create function private.can_view_user(p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and (
    p_target = (select auth.uid())
    or exists (select 1 from public.job_applications a join public.jobs j on j.id = a.job_id
                where (a.worker_id = (select auth.uid()) and j.employer_id = p_target)
                   or (j.employer_id = (select auth.uid()) and a.worker_id = p_target))
    or exists (select 1 from public.bookings b
                where (b.worker_id = (select auth.uid()) and b.employer_id = p_target)
                   or (b.employer_id = (select auth.uid()) and b.worker_id = p_target))
    or (private.app_role() = 'worker'
        and exists (select 1 from public.jobs j
                     where j.employer_id = p_target and j.status = 'open' and j.starts_at > now()))
  );
$$;

-- ---------------------------------------------------------------------------
-- Policies: SELECT only. No INSERT/UPDATE/DELETE policy exists on any table, so
-- those commands are denied by default (and not granted either).
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_view_user(id));

create policy work_categories_select on public.work_categories for select to authenticated
  using (true);

create policy localities_select on public.localities for select to authenticated
  using (true);

create policy worker_profiles_select on public.worker_profiles for select to authenticated
  using (private.can_view_user(user_id));

create policy worker_categories_select on public.worker_categories for select to authenticated
  using (private.can_view_user(worker_id));

create policy jobs_select on public.jobs for select to authenticated
  using (
    employer_id = (select auth.uid())
    or (status = 'open' and starts_at > now() and private.app_role() = 'worker')
    or private.has_applied(id)
    or private.has_booking_on_job(id)
  );

create policy job_applications_select on public.job_applications for select to authenticated
  using (worker_id = (select auth.uid()) or private.owns_job(job_id));

create policy bookings_select on public.bookings for select to authenticated
  using ((select auth.uid()) in (worker_id, employer_id));

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants. Start from nothing, then add exactly what is needed.
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public  from anon, authenticated, service_role;
revoke all on all sequences in schema public  from anon, authenticated, service_role;
revoke all on all functions in schema public  from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated, service_role;

-- Browser reads (RLS applies).
grant select on public.work_categories, public.localities, public.worker_profiles,
                public.worker_categories, public.jobs, public.job_applications,
                public.bookings, public.notifications
  to authenticated;
-- profiles: column-level so is_suspended is never readable by clients.
-- NOTE for the frontend: list columns explicitly; `select=*` will be denied.
grant select (id, role, full_name, org_name, preferred_language, created_at, updated_at)
  on public.profiles to authenticated;

-- Helpers the policies call (policies run with the caller's privileges).
grant execute on function private.app_role(), private.owns_job(uuid), private.has_applied(uuid),
                          private.has_booking_on_job(uuid), private.can_view_user(uuid)
  to authenticated;

-- API functions: service_role only.
grant execute on function
  public.update_profile(uuid, text, text, text),
  public.save_worker_profile(uuid, text, smallint, smallint, boolean, smallint[]),
  public.create_job(uuid, smallint, smallint, text, text, timestamptz, timestamptz, smallint, text, integer),
  public.cancel_job(uuid, uuid, text),
  public.apply_to_job(uuid, uuid, text),
  public.withdraw_application(uuid, uuid),
  public.reject_application(uuid, uuid, text),
  public.accept_application(uuid, uuid),
  public.cancel_booking(uuid, uuid, text),
  public.mark_notifications_read(uuid, uuid[]),
  public.get_applicant_signals(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Backstop: client roles can never write, even if a grant is widened later.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' loop
    execute format(
      'create trigger trg_00_deny_client_writes before insert or update or delete '
      'on public.%I for each statement execute function private.deny_client_writes()', r.relname);
  end loop;
end $$;
