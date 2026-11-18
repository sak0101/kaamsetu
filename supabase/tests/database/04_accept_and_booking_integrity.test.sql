-- accept_application: atomicity, ownership, state checks, overlap prevention,
-- rollback leaves no partial state, and the accepted application is never rejected.
-- Fixture ids: E1=...01 E2=...02, W1..W6 = ...11 .. ...16
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
-- p_start is an offset from now(); fixed base so overlap geometry is exact.
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
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
end $$;

select pg_temp.mk_user('00000000-0000-0000-0000-000000000001', 'employer', 'Employer One');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000002', 'employer', 'Employer Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000011', 'Worker One');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000012', 'Worker Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000013', 'Worker Three');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000014', 'Worker Four');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000015', 'Worker Five');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000016', 'Worker Six');

-- ===========================================================================
-- A. Last-slot acceptance (JA needs 1; three applicants)
-- ===========================================================================
select set_config('t.ja', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '1 day')::text, true);

select pg_temp.as_service();
select set_config('t.a1', public.apply_to_job('00000000-0000-0000-0000-000000000011', current_setting('t.ja')::uuid, null)::text, true);
select set_config('t.a2', public.apply_to_job('00000000-0000-0000-0000-000000000012', current_setting('t.ja')::uuid, null)::text, true);
select set_config('t.a3', public.apply_to_job('00000000-0000-0000-0000-000000000013', current_setting('t.ja')::uuid, null)::text, true);
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000002', current_setting('t.a1')::uuid)$$,
  'KS404', 'application_not_found', 'a different employer cannot accept (looks like not-found)');
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', gen_random_uuid())$$,
  'KS404', 'application_not_found', 'unknown application id gives the same not-found');
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000011', current_setting('t.a1')::uuid)$$,
  'KS403', 'wrong_role', 'a worker cannot accept');
select lives_ok($$select set_config('t.b1', public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.a1')::uuid)::text, true)$$,
  'owner accepts the first applicant');
reset role;

select is((select status from public.bookings where id = current_setting('t.b1')::uuid), 'confirmed', 'booking is confirmed');
select is((select worker_id from public.bookings where id = current_setting('t.b1')::uuid), '00000000-0000-0000-0000-000000000011'::uuid, 'booking belongs to the accepted worker');
select is((select employer_id from public.bookings where id = current_setting('t.b1')::uuid), '00000000-0000-0000-0000-000000000001'::uuid, 'booking belongs to the job owner');
select is((select b.work_period = j.work_period and b.agreed_pay_paise = j.pay_amount_paise
             from public.bookings b join public.jobs j on j.id = b.job_id where b.id = current_setting('t.b1')::uuid),
          true, 'booking copies the job period and pay');
select is((select status from public.job_applications where id = current_setting('t.a1')::uuid), 'accepted',
          'the accepted application stays accepted (never rejected by the auto-reject step)');
select is((select status_reason from public.job_applications where id = current_setting('t.a1')::uuid), null,
          'the accepted application carries no rejection reason');
select is((select count(*)::int from public.job_applications where job_id = current_setting('t.ja')::uuid
            and status = 'rejected' and status_reason = 'job_filled'), 2, 'the two other applicants were auto-rejected as job_filled');
select is((select positions_filled::int from public.jobs where id = current_setting('t.ja')::uuid), 1, 'positions_filled = 1');
select is((select status from public.jobs where id = current_setting('t.ja')::uuid), 'filled', 'job became filled');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000011' and type = 'booking_confirmed'), 1,
          'accepted worker got exactly one booking_confirmed');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000011' and type = 'application_rejected'), 0,
          'accepted worker got no rejection notification');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000011' and entity_type = 'job_application'), 0,
          'accepted worker got no application-level notification (booking_confirmed only)');
select is((select count(*)::int from public.notifications where user_id in
            ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000013') and type = 'application_rejected'), 2,
          'each auto-rejected worker got exactly one rejection notification');

select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.a1')::uuid)$$,
  'KS409', 'application_not_pending', 'double-accept is rejected');
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.a2')::uuid)$$,
  'KS409', 'application_not_pending', 'a rejected application cannot be accepted');
reset role;

-- job_full: a pending application that slipped onto a full job
select set_config('t.afull', pg_temp.mk_app(current_setting('t.ja')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);
select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.afull')::uuid)$$,
  'KS409', 'job_full', 'a full job rejects further accepts');
reset role;
select is((select positions_filled::int from public.jobs where id = current_setting('t.ja')::uuid), 1, 'positions_filled unchanged after job_full');

-- ===========================================================================
-- B. Partial fill (JB needs 2, three applicants)
-- ===========================================================================
select set_config('t.jb', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '2 days', interval '4 hours', 2::smallint)::text, true);
select pg_temp.as_service();
select set_config('t.ba2', public.apply_to_job('00000000-0000-0000-0000-000000000012', current_setting('t.jb')::uuid, null)::text, true);
select set_config('t.ba3', public.apply_to_job('00000000-0000-0000-0000-000000000013', current_setting('t.jb')::uuid, null)::text, true);
select set_config('t.ba4', public.apply_to_job('00000000-0000-0000-0000-000000000014', current_setting('t.jb')::uuid, null)::text, true);
select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ba2')::uuid);
reset role;
select is((select positions_filled::int || '/' || status from public.jobs where id = current_setting('t.jb')::uuid), '1/open', 'JB: 1 of 2 filled, still open');
select is((select count(*)::int from public.job_applications where job_id = current_setting('t.jb')::uuid and status = 'pending'), 2,
          'JB: the other applications are untouched while a slot remains');
select pg_temp.as_service();
select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ba3')::uuid);
reset role;
select is((select positions_filled::int || '/' || status from public.jobs where id = current_setting('t.jb')::uuid), '2/filled', 'JB: now full');
select is((select status || ':' || status_reason from public.job_applications where id = current_setting('t.ba4')::uuid), 'rejected:job_filled',
          'JB: remaining applicant auto-rejected when the last slot went');
select is((select count(*)::int from public.job_applications where id in (current_setting('t.ba2')::uuid, current_setting('t.ba3')::uuid) and status = 'accepted'), 2,
          'JB: both accepted applications remain accepted');

-- ===========================================================================
-- C. Overlap prevention, rollback, and "declared availability cannot override"
--    W1 holds JA (now+1d .. +1d4h). JC (E2) overlaps it; JD (E2) overlaps too; JE starts exactly when JA ends.
-- ===========================================================================
-- JC runs +1d2h .. +1d4h: overlaps JA, and ends exactly when JE starts (so JE does not conflict with it).
select set_config('t.jc', pg_temp.mk_job('00000000-0000-0000-0000-000000000002', interval '1 day 2 hours', interval '2 hours')::text, true);
select set_config('t.jd', pg_temp.mk_job('00000000-0000-0000-0000-000000000002', interval '1 day 1 hour')::text, true);
select set_config('t.je', pg_temp.mk_job('00000000-0000-0000-0000-000000000002', interval '1 day 4 hours')::text, true);

select pg_temp.as_service();
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000011', current_setting('t.jc')::uuid, null)$$,
  'KS409', 'worker_double_booked', 'apply is refused when it overlaps an active booking');
reset role;

-- Simulate the residual race: an application that already existed before the booking.
select set_config('t.cc', pg_temp.mk_app(current_setting('t.jc')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
select set_config('t.snap', (select concat_ws('|',
    (select count(*) from public.bookings),
    (select count(*) from public.notifications),
    (select status from public.job_applications where id = current_setting('t.cc')::uuid),
    (select positions_filled::text || status from public.jobs where id = current_setting('t.jc')::uuid),
    (select count(*) from public.job_applications where status = 'rejected'))), true);

select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000002', current_setting('t.cc')::uuid)$$,
  'KS409', 'worker_double_booked', 'accepting an overlapping job is rejected');
reset role;
select is((select concat_ws('|',
    (select count(*) from public.bookings),
    (select count(*) from public.notifications),
    (select status from public.job_applications where id = current_setting('t.cc')::uuid),
    (select positions_filled::text || status from public.jobs where id = current_setting('t.jc')::uuid),
    (select count(*) from public.job_applications where status = 'rejected'))),
  current_setting('t.snap'),
  'ROLLBACK: failed accept left no booking, no notification, application still pending, job counters unchanged');

-- The exclusion constraint is the final safeguard, independent of the function.
select throws_ok($$select pg_temp.mk_booking(current_setting('t.jd')::uuid, '00000000-0000-0000-0000-000000000011')$$,
  '23P01', null, 'exclusion constraint rejects an overlapping active booking even when inserted directly');

-- Back-to-back is fine (half-open ranges).
select pg_temp.as_service();
select lives_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000011', current_setting('t.je')::uuid, null)$$,
  'a job starting exactly when the previous one ends is allowed');
reset role;
select set_config('t.ae', (select id::text from public.job_applications where job_id = current_setting('t.je')::uuid
                            and worker_id = '00000000-0000-0000-0000-000000000011'), true);
select pg_temp.as_service();
select lives_ok($$select public.accept_application('00000000-0000-0000-0000-000000000002', current_setting('t.ae')::uuid)$$,
  'back-to-back booking accepted');
reset role;

-- A cancelled booking no longer blocks: W1 cancels JA, then JC can be accepted.
select pg_temp.as_service();
select lives_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000011', current_setting('t.b1')::uuid, 'plans changed')$$,
  'worker cancels the JA booking');
select lives_ok($$select public.accept_application('00000000-0000-0000-0000-000000000002', current_setting('t.cc')::uuid)$$,
  'after cancellation the previously conflicting job can be accepted (cancelled bookings do not block)');
reset role;
select is((select positions_filled::int || '/' || status from public.jobs where id = current_setting('t.ja')::uuid), '0/open',
          'cancelling the only booking reopened JA');

-- A completed booking does not block either.
select set_config('t.jf', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '5 days')::text, true);
select set_config('t.jg', pg_temp.mk_job('00000000-0000-0000-0000-000000000002', interval '5 days 1 hour')::text, true);
select set_config('t.bf', pg_temp.mk_booking(current_setting('t.jf')::uuid, '00000000-0000-0000-0000-000000000015')::text, true);
update public.bookings set status = 'completed', completed_at = now() where id = current_setting('t.bf')::uuid;
select pg_temp.as_service();
select lives_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000015', current_setting('t.jg')::uuid, null)$$,
  'a completed booking does not block applying to an overlapping job');
reset role;
select set_config('t.ag', (select id::text from public.job_applications where job_id = current_setting('t.jg')::uuid), true);
select pg_temp.as_service();
select lives_ok($$select public.accept_application('00000000-0000-0000-0000-000000000002', current_setting('t.ag')::uuid)$$,
  'a completed booking does not block accepting an overlapping job');
reset role;

-- ===========================================================================
-- D. Other state checks
-- ===========================================================================
select set_config('t.jh', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '9 days')::text, true);
select set_config('t.ji', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-1 hour', interval '5 hours')::text, true);
select set_config('t.jj', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '11 days')::text, true);
update public.jobs set status = 'cancelled', cancelled_reason = 'test' where id = current_setting('t.jj')::uuid;

select set_config('t.ah', pg_temp.mk_app(current_setting('t.jh')::uuid, '00000000-0000-0000-0000-000000000016')::text, true);
select set_config('t.ai', pg_temp.mk_app(current_setting('t.ji')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);
select set_config('t.aj', pg_temp.mk_app(current_setting('t.jj')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);

select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ai')::uuid)$$,
  'KS409', 'job_already_started', 'a started job cannot take new bookings');
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.aj')::uuid)$$,
  'KS409', 'job_not_open', 'a cancelled job cannot take bookings');
reset role;

update public.profiles set is_suspended = true where id = '00000000-0000-0000-0000-000000000016';
select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ah')::uuid)$$,
  'KS409', 'worker_unavailable', 'a suspended worker cannot be booked');
reset role;
update public.profiles set is_suspended = false where id = '00000000-0000-0000-0000-000000000016';
update public.profiles set is_suspended = true where id = '00000000-0000-0000-0000-000000000001';
select pg_temp.as_service();
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ah')::uuid)$$,
  'KS403', 'account_suspended', 'a suspended employer cannot accept');
reset role;
select is((select count(*)::int from public.bookings where job_id = current_setting('t.jh')::uuid), 0, 'no booking was created by any refused accept on JH');

-- Insert-time guards on bookings (direct, as owner)
update public.profiles set is_suspended = false where id = '00000000-0000-0000-0000-000000000001';
select throws_ok($$insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise, status)
  select j.id, current_setting('t.ah')::uuid, '00000000-0000-0000-0000-000000000016', j.employer_id, tstzrange(now(), now() + interval '1 hour'), 1000, 'confirmed'
    from public.jobs j where j.id = current_setting('t.jh')::uuid$$,
  'KS409', 'booking_period_mismatch', 'a booking whose period differs from the job is rejected');
select throws_ok($$insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise, status)
  select j.id, current_setting('t.ah')::uuid, '00000000-0000-0000-0000-000000000016', j.employer_id, j.work_period, 1000, 'completed'
    from public.jobs j where j.id = current_setting('t.jh')::uuid$$,
  'KS409', 'booking_must_start_confirmed', 'a booking must start as confirmed');
select throws_ok($$insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise, status)
  select j.id, current_setting('t.ah')::uuid, '00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000002', j.work_period, 1000, 'confirmed'
    from public.jobs j where j.id = current_setting('t.jh')::uuid$$,
  '23503', null, 'a booking naming the wrong employer violates the job/employer foreign key');

select * from finish();
rollback;
