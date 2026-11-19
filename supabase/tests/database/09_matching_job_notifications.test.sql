-- Migration 16: notify matching workers about newly posted jobs.
-- Fixture ids: E1=...01, W1..W9 = ...11 .. ...19
begin;
select * from no_plan();

create function pg_temp.mk_user(p_id uuid, p_role text, p_name text default 'Test User') returns uuid
language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (p_id, 'authenticated', 'authenticated', p_id::text || '@test.invalid',
          jsonb_build_object('role', p_role, 'full_name', p_name), now(), now());
  return p_id;
end $$;
-- locality / category are parameters so each worker can differ from the job
create function pg_temp.mk_worker(p_id uuid, p_loc smallint default 1, p_cat smallint default 1, p_avail boolean default true) returns uuid
language plpgsql as $$
begin
  perform pg_temp.mk_user(p_id, 'worker', 'Worker Test');
  update public.worker_profiles set locality_id = p_loc, is_available = p_avail where user_id = p_id;
  insert into public.worker_categories (worker_id, category_id) values (p_id, p_cat);
  return p_id;
end $$;
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
end $$;
create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

select pg_temp.mk_user('00000000-0000-0000-0000-000000000001', 'employer', 'Employer One');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000002', 'employer', 'Employer Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000011');                         -- matches
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000012', 2::smallint);            -- wrong locality
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000013', 1::smallint, 2::smallint); -- wrong category
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000014', 1::smallint, 1::smallint, false); -- unavailable
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000015');                         -- suspended below
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000016');                         -- busy at that time
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000017');                         -- matches, and is also an employer's own helper
update public.profiles set is_suspended = true where id = '00000000-0000-0000-0000-000000000015';

-- W6 already has a confirmed booking on 2099-03-01 09:00-13:00 IST
insert into public.jobs (id, employer_id, category_id, locality_id, title, description, starts_at, ends_at, workers_needed, pay_type, pay_amount_paise)
values ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 1, 1, 'Existing job title', 'd',
        '2099-03-01T03:30:00Z', '2099-03-01T07:30:00Z', 1, 'daily', 80000);
insert into public.job_applications (id, job_id, worker_id, status, decided_at)
values ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000016', 'accepted', now());
insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000016',
        '00000000-0000-0000-0000-000000000002', tstzrange('2099-03-01T03:30:00Z', '2099-03-01T07:30:00Z', '[)'), 80000);
delete from public.notifications;   -- start clean (the setup job above notified nobody relevant to this test)

-- ===========================================================================
-- Eligibility: post a job in locality 1 / category 1 overlapping W6's booking
-- ===========================================================================
select pg_temp.as_service();
select set_config('t.j', public.create_job('00000000-0000-0000-0000-000000000001', 1::smallint, 1::smallint, 'Move a sofa set',
  'Third floor, no lift', '2099-03-01T05:30:00Z', '2099-03-01T09:30:00Z', 2::smallint, 'daily', 90000)::text, true);
reset role;

select is((select array_agg(user_id::text order by user_id::text) from public.notifications where type = 'new_matching_job'),
  array['00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000017'],
  'only available, unsuspended, same-locality, same-category workers with no clash are notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000012'), 0, 'wrong locality: not notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000013'), 0, 'wrong category: not notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000014'), 0, 'marked unavailable: not notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000015'), 0, 'suspended: not notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000016'), 0, 'already booked at that time: not notified');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000001'), 0, 'the employer is never notified of their own job');

-- privacy of the payload
select is((select payload ->> 'job_title' from public.notifications where user_id = '00000000-0000-0000-0000-000000000011' and type = 'new_matching_job'),
  'Move a sofa set', 'the payload carries the title');
select is((select array_agg(k order by k) from public.notifications n, jsonb_object_keys(n.payload) k where n.user_id = '00000000-0000-0000-0000-000000000011' and n.type = 'new_matching_job'),
  array['job_id', 'job_title', 'locality_id'], 'and only id, title and locality: no address, phone or employer details');
select is((select entity_type || ':' || (entity_id = current_setting('t.j')::uuid)::text from public.notifications where user_id = '00000000-0000-0000-0000-000000000011'), 'job:true', 'entity type and id are the job');

-- each worker only sees their own
select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.notifications), 1, 'a notified worker sees exactly their own notification');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000012');
select is((select count(*)::int from public.notifications), 0, 'a non-matching worker sees none');
reset role;

-- ===========================================================================
-- No duplicates, and existing notification types still work
-- ===========================================================================
select throws_ok(format($$insert into public.notifications (user_id, type, entity_type, entity_id) values ('00000000-0000-0000-0000-000000000011', 'new_matching_job', 'job', %L)$$, current_setting('t.j')),
  '23505', null, 'the same worker can never get two matching-job notifications for one job');
select lives_ok($$select private.notify('00000000-0000-0000-0000-000000000011', 'booking_confirmed', 'booking', gen_random_uuid(), '{}')$$, 'existing notification types still insert');
select throws_ok($$insert into public.notifications (user_id, type, entity_type, entity_id) values ('00000000-0000-0000-0000-000000000011', 'made_up', 'job', gen_random_uuid())$$,
  '23514', null, 'unknown types are still rejected');

-- ===========================================================================
-- Fan-out cap (100)
-- ===========================================================================
insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'authenticated', 'authenticated', 'bulk' || g || '@test.invalid',
       '{"role":"worker","full_name":"Bulk Worker"}'::jsonb, now(), now()
  from generate_series(1, 130) g;
update public.worker_profiles set locality_id = 1 where user_id::text like '00000000-0000-0000-0001-%';
insert into public.worker_categories (worker_id, category_id) select user_id, 1 from public.worker_profiles where user_id::text like '00000000-0000-0000-0001-%';
delete from public.notifications;
select pg_temp.as_service();
select set_config('t.j2', public.create_job('00000000-0000-0000-0000-000000000001', 1::smallint, 1::smallint, 'Busy day helpers',
  'Lots of workers match this job', '2099-04-01T05:30:00Z', '2099-04-01T09:30:00Z', 2::smallint, 'daily', 90000)::text, true);
reset role;
select is((select count(*)::int from public.notifications where type = 'new_matching_job' and entity_id = current_setting('t.j2')::uuid), 100,
  'fan-out is capped at 100 workers per job');

-- The cap is fair: a second job notifies a DIFFERENT 100, so across two jobs more than 100 distinct workers are reached
select pg_temp.as_service();
select set_config('t.j3', public.create_job('00000000-0000-0000-0000-000000000001', 1::smallint, 1::smallint, 'Another busy day',
  'Lots of workers match this job too', '2099-04-02T05:30:00Z', '2099-04-02T09:30:00Z', 2::smallint, 'daily', 90000)::text, true);
reset role;
select cmp_ok((select count(distinct user_id)::int from public.notifications where type = 'new_matching_job'
                and entity_id in (current_setting('t.j2')::uuid, current_setting('t.j3')::uuid)), '>', 100,
  'the 100 chosen differ between jobs: no worker is systematically left out (for example newer accounts)');

-- ===========================================================================
-- Creating a job still works when nobody matches (the trigger can never block a post)
-- ===========================================================================
select pg_temp.as_service();
select lives_ok($$select public.create_job('00000000-0000-0000-0000-000000000001', 4::smallint, 17::smallint, 'Garden tidy up',
  'No worker lists this', '2099-05-01T05:30:00Z', '2099-05-01T09:30:00Z', 1::smallint, 'daily', 50000)$$, 'a job nobody matches is created normally');
reset role;

select * from finish();
rollback;
