-- Migrations 13-14: jobs.duration_minutes and privacy-safe job locations.
-- Fixture ids: E1=...01 E2=...02, W1=...11 (booked) W2=...12 (applied only) W3=...13 (stranger)
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
create function pg_temp.mk_worker(p_id uuid, p_name text default 'Worker Test') returns uuid
language plpgsql as $$
begin
  perform pg_temp.mk_user(p_id, 'worker', p_name);
  update public.worker_profiles set locality_id = 1, years_experience = 2 where user_id = p_id;
  insert into public.worker_categories (worker_id, category_id) values (p_id, 1);
  return p_id;
end $$;
create function pg_temp.mk_job(p_employer uuid, p_start interval, p_dur interval default interval '4 hours') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.jobs (employer_id, category_id, locality_id, title, description, starts_at, ends_at,
                           workers_needed, pay_type, pay_amount_paise)
  values (p_employer, 1, 1, 'Test job title', 'Test description', now() + p_start, now() + p_start + p_dur,
          2, 'daily', 80000) returning id into v;
  return v;
end $$;
create function pg_temp.mk_booking(p_job uuid, p_worker uuid) returns uuid
language plpgsql as $$
declare v_app uuid; v_b uuid; j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job;
  insert into public.job_applications (job_id, worker_id, status, decided_at) values (p_job, p_worker, 'accepted', now()) returning id into v_app;
  insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise)
  values (p_job, v_app, p_worker, j.employer_id, j.work_period, j.pay_amount_paise) returning id into v_b;
  return v_b;
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
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000011', 'Worker One');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000012', 'Worker Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000013', 'Worker Three');

-- ===========================================================================
-- duration_minutes
-- ===========================================================================
select set_config('t.j', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '5 days', interval '3 hours 30 minutes')::text, true);
select is((select duration_minutes from public.jobs where id = current_setting('t.j')::uuid), 210, 'duration_minutes is derived from starts_at / ends_at');
select set_config('t.long', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '6 days', interval '2 days')::text, true);
select is((select duration_minutes from public.jobs where id = current_setting('t.long')::uuid), 2880, 'a two-day job is 2880 minutes');

-- ===========================================================================
-- save_job_location
-- ===========================================================================
select pg_temp.as_service();
select lives_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, '  12 Race Course Circle  ', ' Near the fountain ')$$, current_setting('t.j')),
  'the employer sets an address and landmark');
select throws_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000002', %L, '99 Another Road', null)$$, current_setting('t.j')),
  'KS404', 'job_not_found', 'another employer cannot set it (same 404 as a missing job)');
select throws_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000011', %L, '99 Another Road', null)$$, current_setting('t.j')),
  'KS403', 'wrong_role', 'a worker cannot set it');
select throws_ok($$select public.save_job_location('00000000-0000-0000-0000-000000000001', gen_random_uuid(), '99 Another Road', null)$$,
  'KS404', 'job_not_found', 'an unknown job is 404');
select throws_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, 'abc', null)$$, current_setting('t.j')),
  'KS422', 'invalid_location', 'a too-short address is rejected');
select throws_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, '12 Race Course Circle', %L)$$, current_setting('t.j'), repeat('x', 101)),
  'KS422', 'invalid_location', 'a landmark over 100 characters is rejected');
reset role;
select is((select address_line || '|' || landmark from public.job_locations where job_id = current_setting('t.j')::uuid),
  '12 Race Course Circle|Near the fountain', 'address and landmark are trimmed and stored');

select pg_temp.as_service();
select lives_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, '14 Race Course Circle', null)$$, current_setting('t.j')),
  'the employer can change it (upsert)');
reset role;
select is((select count(*)::int from public.job_locations where job_id = current_setting('t.j')::uuid), 1, 'still exactly one row per job');
select is((select landmark from public.job_locations where job_id = current_setting('t.j')::uuid), null, 'landmark cleared when omitted');

-- ===========================================================================
-- Who can read it
-- ===========================================================================
select set_config('t.bk', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
insert into public.job_applications (job_id, worker_id) values (current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000012');

select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.job_locations), 1, 'the owning employer reads it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.job_locations), 0, 'another employer cannot read it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.job_locations), 1, 'a worker with a live booking reads it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000012');
select is((select count(*)::int from public.job_locations), 0, 'a worker who only APPLIED cannot read it');
select is((select count(*)::int from public.jobs where id = current_setting('t.j')::uuid), 1, 'but the job itself is still listed for them');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000013');
select is((select count(*)::int from public.job_locations), 0, 'a stranger worker cannot read it');
reset role;

-- anon and direct writes
set local role anon;
select throws_ok($$select count(*) from public.job_locations$$, '42501', null, 'anon has no access at all');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select throws_ok(format($$insert into public.job_locations (job_id, address_line) values (%L, 'hacked address')$$, current_setting('t.long')),
  '42501', null, 'the owner cannot write directly either (no INSERT grant)');
reset role;
select pg_temp.as_service();
select throws_ok($$select count(*) from public.job_locations$$, '42501', null, 'service_role has no table access (functions only)');
reset role;

-- The booking stops granting access when it is cancelled
update public.bookings set status = 'cancelled_by_employer', cancelled_by = '00000000-0000-0000-0000-000000000001', cancelled_at = now()
 where id = current_setting('t.bk')::uuid;
select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.job_locations), 0, 'a cancelled booking no longer reveals the address');
reset role;

-- ... and neither does a booking whose job has ended
select set_config('t.old', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-5 hours', interval '4 hours')::text, true);
insert into public.job_locations (job_id, address_line) values (current_setting('t.old')::uuid, '7 Old Road Alkapuri');
select pg_temp.mk_booking(current_setting('t.old')::uuid, '00000000-0000-0000-0000-000000000013');
select pg_temp.as_user('00000000-0000-0000-0000-000000000013');
select is((select count(*)::int from public.job_locations), 0, 'a booking on a job that has already ended no longer reveals the address');
reset role;

-- a worker who holds a live booking on a DIFFERENT job of the same employer still cannot read this job's address
select pg_temp.mk_booking(current_setting('t.long')::uuid, '00000000-0000-0000-0000-000000000012');
select pg_temp.as_user('00000000-0000-0000-0000-000000000012');
select is((select count(*)::int from public.job_locations), 0, 'a live booking on another job does not reveal this job''s address');
reset role;

-- Clearing and cancelled jobs
select pg_temp.as_service();
select lives_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, '   ', null)$$, current_setting('t.j')), 'a blank address clears it');
reset role;
select is((select count(*)::int from public.job_locations where job_id = current_setting('t.j')::uuid), 0, 'the location row is deleted');
update public.jobs set status = 'cancelled' where id = current_setting('t.long')::uuid;
select pg_temp.as_service();
select throws_ok(format($$select public.save_job_location('00000000-0000-0000-0000-000000000001', %L, '14 Race Course Circle', null)$$, current_setting('t.long')),
  'KS409', 'job_not_editable', 'a cancelled job cannot be edited');
reset role;

select * from finish();
rollback;
