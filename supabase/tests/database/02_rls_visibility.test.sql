-- RLS: who can SELECT what, and that every client write is denied.
begin;
select * from no_plan();

create function pg_temp.u(n int) returns uuid language sql as
  $$ select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
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
create function pg_temp.mk_job(p_employer uuid, p_start interval, p_dur interval default interval '4 hours',
                               p_needed smallint default 1) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.jobs (employer_id, category_id, locality_id, title, description, starts_at, ends_at,
                           workers_needed, pay_type, pay_amount_paise)
  values (p_employer, 1, 1, 'Test job title', 'Test description', now() + p_start, now() + p_start + p_dur,
          p_needed, 'daily', 80000) returning id into v;
  return v;
end $$;
create function pg_temp.mk_app(p_job uuid, p_worker uuid, p_status text default 'pending') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.job_applications (job_id, worker_id, status, decided_at)
  values (p_job, p_worker, p_status, case when p_status = 'pending' then null else now() end) returning id into v;
  return v;
end $$;
create function pg_temp.mk_booking(p_job uuid, p_worker uuid) returns uuid
language plpgsql as $$
declare v_app uuid; v_b uuid; j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job;
  v_app := pg_temp.mk_app(p_job, p_worker, 'accepted');
  insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise)
  values (p_job, v_app, p_worker, j.employer_id, j.work_period, j.pay_amount_paise) returning id into v_b;
  return v_b;
end $$;
create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end $$;

-- Fixture: E1,E2 employers; W1,W2,W3 workers.
select pg_temp.mk_user('00000000-0000-0000-0000-000000000001'::uuid, 'employer', 'Employer One');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000002'::uuid, 'employer', 'Employer Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000011'::uuid, 'Worker One');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000012'::uuid, 'Worker Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000013'::uuid, 'Worker Three');

select set_config('t.j1', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '1 day')::text, true);                 -- E1 open, future
select set_config('t.j2', pg_temp.mk_job('00000000-0000-0000-0000-000000000002'::uuid, interval '1 day')::text, true);                 -- E2 open, future
select set_config('t.jpast', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '-2 days')::text, true);            -- E1 open, already started
select set_config('t.j4', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '3 days')::text, true);                -- E1 open, future (W3 booked)
select pg_temp.mk_app(current_setting('t.j1')::uuid, '00000000-0000-0000-0000-000000000011'::uuid);                                    -- W1 -> J1
select pg_temp.mk_app(current_setting('t.j2')::uuid, '00000000-0000-0000-0000-000000000012'::uuid);                                    -- W2 -> J2
select pg_temp.mk_booking(current_setting('t.j4')::uuid, '00000000-0000-0000-0000-000000000013'::uuid);                                -- W3 booked on J4

-- ---------------------------------------------------------------------------
-- Worker W1
-- ---------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-000000000011'::uuid);
select is((select count(*)::int from public.jobs), 2,
  'W1 sees open future jobs (J1, J2); not the started job, not the filled job J4');
select is((select count(*)::int from public.jobs where id = current_setting('t.jpast')::uuid), 0,
  'W1 cannot see a job whose start time has passed');
select is((select count(*)::int from public.job_applications), 1, 'W1 sees only own application');
select is((select count(*)::int from public.bookings), 0, 'W1 sees no bookings');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-000000000012'::uuid), 0, 'W1 cannot see worker W2');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-000000000011'::uuid), 1, 'W1 sees self');
select is((select count(*)::int from public.profiles where role = 'employer'), 2,
  'W1 sees employers that have open future jobs');
select is((select count(*)::int from public.worker_profiles where user_id <> '00000000-0000-0000-0000-000000000011'::uuid), 0,
  'W1 sees no other worker profiles');
select is((select count(*)::int from public.notifications where user_id <> '00000000-0000-0000-0000-000000000011'::uuid), 0,
  'W1 sees no one else''s notifications');
select is((select count(*)::int from public.work_categories), 8, 'W1 can read categories');
select is((select count(*)::int from public.localities), 18, 'W1 can read localities');
reset role;

-- ---------------------------------------------------------------------------
-- Employer E1
-- ---------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-000000000001'::uuid);
select is((select count(*)::int from public.jobs), 3, 'E1 sees only own jobs (J1, JPAST, J4)');
select is((select count(*)::int from public.jobs where employer_id = '00000000-0000-0000-0000-000000000002'::uuid), 0, 'E1 cannot see E2''s job');
select is((select count(*)::int from public.job_applications), 2,
  'E1 sees applications on own jobs (W1->J1 and W3->J4) and not W2->J2');
select is((select count(*)::int from public.profiles where id in ('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-000000000013'::uuid)), 2,
  'E1 sees profiles of applicants/booked workers');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-000000000012'::uuid), 0,
  'E1 cannot see an unrelated worker (W2)');
select is((select count(*)::int from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000012'::uuid), 0,
  'E1 cannot see an unrelated worker_profile');
select is((select count(*)::int from public.bookings), 1, 'E1 sees the booking on own job');
select is((select count(*)::int from public.notifications where user_id <> '00000000-0000-0000-0000-000000000001'::uuid), 0,
  'E1 sees only own notifications');
select cmp_ok((select count(*)::int from public.notifications), '>', 0, 'E1 has notifications (new_application)');
reset role;

-- E2 / W3 / W2
select pg_temp.as_user('00000000-0000-0000-0000-000000000002'::uuid);
select is((select count(*)::int from public.bookings), 0, 'E2 sees no bookings');
select is((select count(*)::int from public.job_applications), 1, 'E2 sees only the application on own job');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-000000000013'::uuid);
select is((select count(*)::int from public.bookings), 1, 'W3 sees own booking');
select is((select count(*)::int from public.jobs where id = current_setting('t.j4')::uuid), 1, 'W3 sees the job they are booked on');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-000000000001'::uuid), 1, 'W3 sees the employer of their booking');
reset role;

-- ---------------------------------------------------------------------------
-- anon sees nothing; sensitive column and wildcard denied
-- ---------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select count(*) from public.jobs$$, '42501'::char(5), null, 'anon cannot read jobs');
select throws_ok($$select count(*) from public.profiles$$, '42501'::char(5), null, 'anon cannot read profiles');
select throws_ok($$select count(*) from public.work_categories$$, '42501'::char(5), null, 'anon cannot read categories');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-000000000011'::uuid);
select throws_ok($$select is_suspended from public.profiles$$, '42501'::char(5), null,
  'authenticated cannot read profiles.is_suspended');
select throws_ok($$select * from public.profiles$$, '42501'::char(5), null,
  'select * on profiles is denied (columns must be listed)');

-- ---------------------------------------------------------------------------
-- Every client write is denied (no grant): INSERT / UPDATE / DELETE on every table
-- ---------------------------------------------------------------------------
select throws_ok(format('insert into public.%I default values', t.name), '42501'::char(5), null,
                 'authenticated cannot INSERT into ' || t.name)
  from (values ('profiles'), ('worker_profiles'), ('worker_categories'), ('work_categories'), ('localities'),
               ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
select throws_ok(format('update public.%I set id = id', t.name), '42501'::char(5), null,
                 'authenticated cannot UPDATE ' || t.name)
  from (values ('profiles'), ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
select throws_ok($$update public.profiles set role = 'employer' where id = '00000000-0000-0000-0000-000000000011'$$,
  '42501'::char(5), null, 'a user cannot change their own role');
select throws_ok($$update public.profiles set is_suspended = false where id = '00000000-0000-0000-0000-000000000011'$$,
  '42501'::char(5), null, 'a user cannot change their own suspension');
select throws_ok($$update public.bookings set status = 'completed'$$,
  '42501'::char(5), null, 'a user cannot change booking status');
select throws_ok($$update public.worker_profiles set bio = 'x'$$,
  '42501'::char(5), null, 'a worker cannot update worker_profiles directly (Express only)');
select throws_ok(format('delete from public.%I', t.name), '42501'::char(5), null,
                 'authenticated cannot DELETE from ' || t.name)
  from (values ('profiles'), ('jobs'), ('job_applications'), ('bookings'), ('notifications'),
               ('worker_categories')) t(name);
reset role;

select * from finish();
rollback;
