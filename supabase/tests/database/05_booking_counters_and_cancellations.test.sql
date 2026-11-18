-- positions_filled transitions, bounds (never negative / never above workers_needed),
-- booking state machine, cancellation attribution, cancel_booking and cancel_job.
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
-- "positions/status" snapshot of a job
create function pg_temp.pf(p_job uuid) returns text language sql as
  $$ select positions_filled::text || '/' || status from public.jobs where id = p_job $$;
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
-- 1. Counter transitions on a 3-slot job
-- ===========================================================================
select set_config('t.j', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '10 days', interval '4 hours', 3::smallint)::text, true);
select is(pg_temp.pf(current_setting('t.j')::uuid), '0/open', 'start: 0/open');
select set_config('t.b1', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/open', 'booking 1 -> 1/open');
select set_config('t.b2', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000012')::text, true);
select is(pg_temp.pf(current_setting('t.j')::uuid), '2/open', 'booking 2 -> 2/open');
select set_config('t.b3', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000013')::text, true);
select is(pg_temp.pf(current_setting('t.j')::uuid), '3/filled', 'booking 3 -> 3/filled');

select throws_ok($$select pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000014')$$,
  'KS409', 'job_not_open', 'a 4th booking on a filled job is refused');
select is(pg_temp.pf(current_setting('t.j')::uuid), '3/filled', 'counter unchanged after the refused 4th booking');

-- Bypass attempt: reopen the job by hand, then try to overbook. The CHECK is the backstop.
update public.jobs set status = 'open' where id = current_setting('t.j')::uuid;
select throws_ok($$select pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000014')$$,
  '23514', null, 'overbooking is blocked by jobs_positions_check even when the job is wrongly open');
update public.jobs set status = 'filled' where id = current_setting('t.j')::uuid;
select is(pg_temp.pf(current_setting('t.j')::uuid), '3/filled', 'counter still 3 after the blocked overbook');

-- Worker cancels (API): 3 -> 2, job reopens.
select pg_temp.as_service();
select lives_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000011', current_setting('t.b1')::uuid, 'sick')$$, 'worker cancels b1');
reset role;
select is(pg_temp.pf(current_setting('t.j')::uuid), '2/open', 'worker cancel -> 2/open (filled job reopened)');

-- Employer cancels (API): 2 -> 1.
select pg_temp.as_service();
select lives_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000001', current_setting('t.b2')::uuid, null)$$, 'employer cancels b2');
reset role;
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/open', 'employer cancel -> 1/open');

-- confirmed -> in_progress -> completed keeps the slot occupied (no delta); completed is terminal.
update public.bookings set status = 'in_progress' where id = current_setting('t.b3')::uuid;
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/open', 'confirmed -> in_progress: no change');
update public.bookings set status = 'completed', completed_at = now() where id = current_setting('t.b3')::uuid;
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/open', 'in_progress -> completed: no change (slot stays used)');
select throws_ok($$update public.bookings set status = 'cancelled_by_employer', cancelled_by = '00000000-0000-0000-0000-000000000001',
  cancelled_at = now() where id = current_setting('t.b3')::uuid$$, 'KS409', 'invalid_booking_transition', 'completed is terminal (no cancel)');
select throws_ok($$update public.bookings set status = 'confirmed' where id = current_setting('t.b3')::uuid$$,
  'KS409', 'invalid_booking_transition', 'completed cannot go back to confirmed');
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/open', 'terminal-state guards left the counter unchanged');

-- cancel_job: job cancelled, completed booking untouched, job never reopens.
select pg_temp.as_service();
select lives_ok($$select public.cancel_job('00000000-0000-0000-0000-000000000001', current_setting('t.j')::uuid, 'plans changed')$$, 'employer cancels the job');
reset role;
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/cancelled', 'cancel_job: status cancelled, completed booking still counted, not reopened');
select is((select status from public.bookings where id = current_setting('t.b3')::uuid), 'completed', 'cancel_job leaves the completed booking alone');

-- ===========================================================================
-- 2. no_show / admin reversal / double-decrement guards on a 2-slot job
-- ===========================================================================
select set_config('t.k', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '11 days', interval '4 hours', 2::smallint)::text, true);
select set_config('t.k1', pg_temp.mk_booking(current_setting('t.k')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
select set_config('t.k2', pg_temp.mk_booking(current_setting('t.k')::uuid, '00000000-0000-0000-0000-000000000012')::text, true);
select is(pg_temp.pf(current_setting('t.k')::uuid), '2/filled', 'K: 2/filled');
update public.bookings set status = 'no_show' where id = current_setting('t.k1')::uuid;
select is(pg_temp.pf(current_setting('t.k')::uuid), '1/open', 'confirmed -> no_show frees the slot once');
update public.bookings set status = 'cancelled_by_admin', cancelled_by = '00000000-0000-0000-0000-000000000001', cancelled_at = now()
 where id = current_setting('t.k1')::uuid;
select is(pg_temp.pf(current_setting('t.k')::uuid), '1/open', 'no_show -> cancelled_by_admin: no second decrement');
select throws_ok($$update public.bookings set status = 'cancelled_by_worker', cancelled_by = '00000000-0000-0000-0000-000000000011',
  cancelled_at = now() where id = current_setting('t.k1')::uuid$$, 'KS409', 'invalid_booking_transition', 'cancelled -> cancelled is refused (no double decrement)');
select throws_ok($$update public.bookings set status = 'confirmed', cancelled_by = null, cancelled_at = null where id = current_setting('t.k1')::uuid$$,
  'KS409', 'invalid_booking_transition', 'a cancelled booking cannot be resurrected');
select is(pg_temp.pf(current_setting('t.k')::uuid), '1/open', 'K counter intact after refused transitions');

-- Direct tampering with the counter is rejected by the CHECK.
select throws_ok($$update public.jobs set positions_filled = -1 where id = current_setting('t.k')::uuid$$,
  '23514', null, 'positions_filled can never be negative');
select throws_ok($$update public.jobs set positions_filled = 3 where id = current_setting('t.k')::uuid$$,
  '23514', null, 'positions_filled can never exceed workers_needed');
select throws_ok($$update public.jobs set workers_needed = 0 where id = current_setting('t.k')::uuid$$,
  '23514', null, 'workers_needed cannot drop to zero');
select throws_ok($$update public.jobs set workers_needed = 1, positions_filled = 2 where id = current_setting('t.k')::uuid$$,
  '23514', null, 'workers_needed cannot drop below positions_filled');
select is(pg_temp.pf(current_setting('t.k')::uuid), '1/open', 'K counter intact after tamper attempts');

-- A job that has already started does not reopen when a slot is freed.
select set_config('t.l', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-1 hour', interval '4 hours')::text, true);
select set_config('t.l1', pg_temp.mk_booking(current_setting('t.l')::uuid, '00000000-0000-0000-0000-000000000013')::text, true);
select is(pg_temp.pf(current_setting('t.l')::uuid), '1/filled', 'L: started job filled');
update public.bookings set status = 'cancelled_by_admin', cancelled_by = '00000000-0000-0000-0000-000000000001', cancelled_at = now()
 where id = current_setting('t.l1')::uuid;
select is(pg_temp.pf(current_setting('t.l')::uuid), '0/filled', 'freed slot on a started job: counter 0, status stays filled (not reopened)');

-- ===========================================================================
-- 3. cancel_booking rules and attribution (job M, 2 slots)
-- ===========================================================================
select set_config('t.m', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '12 days', interval '4 hours', 2::smallint)::text, true);
select set_config('t.m1', pg_temp.mk_booking(current_setting('t.m')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);
select set_config('t.m2', pg_temp.mk_booking(current_setting('t.m')::uuid, '00000000-0000-0000-0000-000000000015')::text, true);

select pg_temp.as_service();
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000016', current_setting('t.m1')::uuid, null)$$,
  'KS404', 'booking_not_found', 'an unrelated worker cannot cancel');
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000002', current_setting('t.m1')::uuid, null)$$,
  'KS404', 'booking_not_found', 'an unrelated employer cannot cancel');
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000014', gen_random_uuid(), null)$$,
  'KS404', 'booking_not_found', 'unknown booking id -> not found');
select lives_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000014', current_setting('t.m1')::uuid, 'family emergency')$$,
  'worker cancels own confirmed booking');
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000014', current_setting('t.m1')::uuid, null)$$,
  'KS409', 'booking_not_cancellable', 'cancelling twice is refused');
reset role;
select is((select status || '|' || cancelled_by::text from public.bookings where id = current_setting('t.m1')::uuid),
  'cancelled_by_worker|00000000-0000-0000-0000-000000000014', 'worker cancel is attributed to the worker');
select is((select cancel_reason from public.bookings where id = current_setting('t.m1')::uuid), 'family emergency', 'reason stored');
select is((select payload ->> 'cancelled_by' from public.notifications
            where user_id = '00000000-0000-0000-0000-000000000001' and type = 'booking_cancelled'
              and entity_id = current_setting('t.m1')::uuid), 'worker', 'employer was notified of the worker cancellation');
select is(pg_temp.pf(current_setting('t.m')::uuid), '1/open', 'M: counter 1 after worker cancel');

-- in_progress: worker cannot cancel, employer can.
update public.bookings set status = 'in_progress' where id = current_setting('t.m2')::uuid;
select pg_temp.as_service();
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000015', current_setting('t.m2')::uuid, null)$$,
  'KS409', 'booking_not_cancellable', 'a worker cannot cancel a booking that is in progress');
select lives_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000001', current_setting('t.m2')::uuid, null)$$,
  'employer can cancel an in-progress booking');
reset role;
select is((select status || '|' || cancelled_by::text from public.bookings where id = current_setting('t.m2')::uuid),
  'cancelled_by_employer|00000000-0000-0000-0000-000000000001', 'employer cancel is attributed to the employer, never the worker');
select is((select payload ->> 'cancelled_by' from public.notifications
            where user_id = '00000000-0000-0000-0000-000000000015' and type = 'booking_cancelled'
              and entity_id = current_setting('t.m2')::uuid), 'employer', 'worker was notified of the employer cancellation');
select is(pg_temp.pf(current_setting('t.m')::uuid), '0/open', 'M: counter 0 after both cancellations');

-- Slot reuse: a different worker takes a freed slot through the normal API path.
select pg_temp.as_service();
select set_config('t.ma', public.apply_to_job('00000000-0000-0000-0000-000000000016', current_setting('t.m')::uuid, null)::text, true);
select lives_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.ma')::uuid)$$, 'a freed slot can be filled again');
reset role;
select is(pg_temp.pf(current_setting('t.m')::uuid), '1/open', 'M: counter 1 after re-fill');

-- Attribution CHECKs: the label must match the actor.
select set_config('t.m3', pg_temp.mk_booking(current_setting('t.m')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
select throws_ok($$update public.bookings set status = 'cancelled_by_worker', cancelled_by = '00000000-0000-0000-0000-000000000001',
  cancelled_at = now() where id = current_setting('t.m3')::uuid$$, '23514', null,
  'an employer-caused cancellation cannot be recorded as worker-caused');
select throws_ok($$update public.bookings set status = 'cancelled_by_employer', cancelled_by = '00000000-0000-0000-0000-000000000011',
  cancelled_at = now() where id = current_setting('t.m3')::uuid$$, '23514', null,
  'a worker-caused cancellation cannot be recorded as employer-caused');
select throws_ok($$update public.bookings set status = 'cancelled_by_admin' where id = current_setting('t.m3')::uuid$$,
  '23514', null, 'a cancelled status requires cancelled_by and cancelled_at');

-- A booking whose job has ended cannot be cancelled.
select set_config('t.n', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-5 hours', interval '4 hours')::text, true);
select set_config('t.n1', pg_temp.mk_booking(current_setting('t.n')::uuid, '00000000-0000-0000-0000-000000000016')::text, true);
select pg_temp.as_service();
select throws_ok($$select public.cancel_booking('00000000-0000-0000-0000-000000000016', current_setting('t.n1')::uuid, null)$$,
  'KS409', 'booking_already_ended', 'a finished booking cannot be cancelled');
reset role;

-- ===========================================================================
-- 4. cancel_job with pending applications and active bookings (job P, 2 slots)
-- ===========================================================================
select set_config('t.p', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '14 days', interval '4 hours', 3::smallint)::text, true);
select set_config('t.p1', pg_temp.mk_booking(current_setting('t.p')::uuid, '00000000-0000-0000-0000-000000000012')::text, true);
select set_config('t.p2', pg_temp.mk_booking(current_setting('t.p')::uuid, '00000000-0000-0000-0000-000000000013')::text, true);
select set_config('t.pa4', pg_temp.mk_app(current_setting('t.p')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);
select set_config('t.pa5', pg_temp.mk_app(current_setting('t.p')::uuid, '00000000-0000-0000-0000-000000000015')::text, true);
select is(pg_temp.pf(current_setting('t.p')::uuid), '2/open', 'P: 2 of 3 filled');

select pg_temp.as_service();
select throws_ok($$select public.cancel_job('00000000-0000-0000-0000-000000000002', current_setting('t.p')::uuid, null)$$,
  'KS404', 'job_not_found', 'another employer cannot cancel the job');
select throws_ok($$select public.cancel_job('00000000-0000-0000-0000-000000000012', current_setting('t.p')::uuid, null)$$,
  'KS403', 'wrong_role', 'a worker cannot cancel a job');
select lives_ok($$select public.cancel_job('00000000-0000-0000-0000-000000000001', current_setting('t.p')::uuid, 'client withdrew')$$,
  'owner cancels job P');
select throws_ok($$select public.cancel_job('00000000-0000-0000-0000-000000000001', current_setting('t.p')::uuid, null)$$,
  'KS409', 'job_not_cancellable', 'cancelling twice is refused');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000016', current_setting('t.p')::uuid, null)$$,
  'KS409', 'job_not_open', 'nobody can apply to a cancelled job');
select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.pa4')::uuid)$$,
  'KS409', 'application_not_pending', 'nothing can be accepted on a cancelled job');
reset role;

select is(pg_temp.pf(current_setting('t.p')::uuid), '0/cancelled', 'P: counter 0, status cancelled (never reopened by the slot trigger)');
select is((select cancelled_reason from public.jobs where id = current_setting('t.p')::uuid), 'client withdrew', 'job cancellation reason stored');
select is((select count(*)::int from public.bookings where job_id = current_setting('t.p')::uuid
            and status = 'cancelled_by_employer' and cancelled_by = '00000000-0000-0000-0000-000000000001'), 2,
          'both active bookings cancelled and attributed to the employer');
select is((select count(*)::int from public.job_applications where job_id = current_setting('t.p')::uuid
            and status = 'rejected' and status_reason = 'job_cancelled'), 2, 'pending applications rejected with job_cancelled');
select is((select count(*)::int from public.job_applications where job_id = current_setting('t.p')::uuid and status = 'accepted'), 2,
          'accepted applications stay accepted (history)');
select is((select count(*)::int from public.notifications where type = 'booking_cancelled'
            and entity_id in (current_setting('t.p1')::uuid, current_setting('t.p2')::uuid)
            and payload ->> 'cancelled_by' = 'employer'), 2, 'booked workers notified of the employer cancellation');
select is((select count(*)::int from public.notifications where type = 'application_rejected'
            and user_id in ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000015')
            and payload ->> 'reason' = 'job_cancelled'), 2, 'pending applicants notified with reason job_cancelled');

-- Invariant over everything this file created: counter == slot-occupying bookings, within bounds.
select is((select count(*)::int from public.jobs j
            where j.positions_filled <> (select count(*) from public.bookings b
                                          where b.job_id = j.id and b.status in ('confirmed', 'in_progress', 'completed'))
               or j.positions_filled < 0 or j.positions_filled > j.workers_needed), 0,
          'INVARIANT: positions_filled equals slot-occupying bookings and stays within [0, workers_needed] for every job');

select * from finish();
rollback;
