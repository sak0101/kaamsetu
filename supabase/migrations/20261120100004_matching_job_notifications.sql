-- KaamSetu migration 16: notify matching workers about newly posted jobs
--
-- When an employer posts a job, workers who (a) work in that locality, (b) offer that category, (c) are marked
-- available, (d) are not suspended and (e) have no confirmed / in-progress booking overlapping the job are
-- notified in-app. Safeguards:
--   * fan-out is capped at 100 workers per job. When more than 100 match, WHICH 100 is decided by a hash of (worker, job):
--     stable for a job but different from job to job, so newer workers are never systematically left out;
--   * one notification per (worker, job): a partial unique index plus ON CONFLICT DO NOTHING;
--   * the payload carries only the job id, title and locality (never an address, phone or employer detail);
--   * nothing in the new-job write path can fail because of notifications: the trigger only inserts.
-- Existing notification types, Realtime publication and polling are unchanged.

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('new_application', 'application_rejected', 'booking_confirmed', 'booking_cancelled', 'new_matching_job'));

alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check
  check (entity_type in ('job_application', 'booking', 'job'));

create unique index notifications_one_match_per_job_idx
  on public.notifications (user_id, entity_id) where type = 'new_matching_job';

create function private.jobs_notify_matches() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, type, entity_type, entity_id, payload)
  select wp.user_id, 'new_matching_job', 'job', new.id,
         jsonb_build_object('job_id', new.id, 'job_title', new.title, 'locality_id', new.locality_id)
    from public.worker_profiles wp
    join public.profiles p on p.id = wp.user_id
   where wp.locality_id = new.locality_id
     and wp.is_available
     and not p.is_suspended
     and exists (select 1 from public.worker_categories wc
                  where wc.worker_id = wp.user_id and wc.category_id = new.category_id)
     and not exists (select 1 from public.bookings b
                      where b.worker_id = wp.user_id
                        and b.status in ('confirmed', 'in_progress')
                        and b.work_period && new.work_period)
   order by md5(wp.user_id::text || new.id::text)
   limit 100
  on conflict do nothing;
  return null;
end $$;

create trigger trg_jobs_20_notify_matches
  after insert on public.jobs
  for each row execute function private.jobs_notify_matches();

revoke all on function private.jobs_notify_matches() from public, anon, authenticated, service_role;
