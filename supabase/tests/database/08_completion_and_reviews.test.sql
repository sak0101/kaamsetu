-- Migration 15: finish_booking (completed / no_show), booking_reviews, applicant review facts.
-- Fixture ids: E1=...01 E2=...02, W1=...11 W2=...12 W3=...13 W4=...14
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
                               p_needed smallint default 2) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.jobs (employer_id, category_id, locality_id, title, description, starts_at, ends_at,
                           workers_needed, pay_type, pay_amount_paise)
  values (p_employer, 1, 1, 'Test job title', 'Test description', now() + p_start, now() + p_start + p_dur,
          p_needed, 'daily', 80000) returning id into v;
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
create function pg_temp.pf(p_job uuid) returns text language sql as
  $$ select positions_filled::text || '/' || status from public.jobs where id = p_job $$;
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
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000014', 'Worker Four');

-- A job that started an hour ago with two booked workers, and a future job.
select set_config('t.j', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-1 hour', interval '5 hours')::text, true);
select set_config('t.b1', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000011')::text, true);
select set_config('t.b2', pg_temp.mk_booking(current_setting('t.j')::uuid, '00000000-0000-0000-0000-000000000012')::text, true);
select set_config('t.fut', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '3 days')::text, true);
select set_config('t.bf', pg_temp.mk_booking(current_setting('t.fut')::uuid, '00000000-0000-0000-0000-000000000013')::text, true);
select is(pg_temp.pf(current_setting('t.j')::uuid), '2/filled', 'setup: 2/filled');

-- ===========================================================================
-- finish_booking
-- ===========================================================================
select pg_temp.as_service();
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'completed')$$, current_setting('t.bf')),
  'KS409', 'job_not_started', 'cannot be finished before the job has started');
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'no_show')$$, current_setting('t.bf')),
  'KS409', 'job_not_started', 'no-show cannot be recorded before the job has started either');
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000002', %L, 'completed')$$, current_setting('t.b1')),
  'KS404', 'booking_not_found', 'another employer cannot finish it (same 404 as a missing booking)');
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000011', %L, 'completed')$$, current_setting('t.b1')),
  'KS403', 'wrong_role', 'a worker cannot finish a booking');
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'cancelled_by_worker')$$, current_setting('t.b1')),
  'KS422', 'invalid_outcome', 'only completed / no_show are accepted outcomes');
select throws_ok($$select public.finish_booking('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'completed')$$,
  'KS404', 'booking_not_found', 'an unknown booking is 404');
select lives_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'completed')$$, current_setting('t.b1')),
  'the employer marks a started booking completed');
reset role;
select is((select status || '|' || (completed_at is not null)::text from public.bookings where id = current_setting('t.b1')::uuid), 'completed|true', 'completed with a timestamp');
select is(pg_temp.pf(current_setting('t.j')::uuid), '2/filled', 'a completed booking keeps its slot');

select pg_temp.as_service();
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'no_show')$$, current_setting('t.b1')),
  'KS409', 'booking_not_finishable', 'a completed booking cannot be changed again');
select lives_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'no_show')$$, current_setting('t.b2')),
  'the employer records a no-show');
reset role;
select is((select status || '|' || (completed_at is null)::text from public.bookings where id = current_setting('t.b2')::uuid), 'no_show|true', 'no_show has no completion time');
select is(pg_temp.pf(current_setting('t.j')::uuid), '1/filled', 'a no-show releases its slot counter (counters stay in sync)');
select is((select count(*)::int from public.notifications where type = 'booking_cancelled'), 0, 'finishing a booking is not recorded as a cancellation');

-- ===========================================================================
-- submit_review
-- ===========================================================================
select pg_temp.as_service();
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000013', %L, 5::smallint, 'x')$$, current_setting('t.bf')),
  'KS409', 'booking_not_completed', 'cannot review a booking that is not completed');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000012', %L, 5::smallint, 'x')$$, current_setting('t.b2')),
  'KS409', 'booking_not_completed', 'cannot review a no-show');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000014', %L, 5::smallint, 'x')$$, current_setting('t.b1')),
  'KS404', 'booking_not_found', 'a stranger cannot review a booking they are not part of');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000002', %L, 5::smallint, 'x')$$, current_setting('t.b1')),
  'KS404', 'booking_not_found', 'another employer cannot review it either');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000011', %L, 6::smallint, 'x')$$, current_setting('t.b1')),
  'KS422', 'invalid_rating', 'rating above 5 rejected');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000011', %L, 0::smallint, 'x')$$, current_setting('t.b1')),
  'KS422', 'invalid_rating', 'rating below 1 rejected');
select lives_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000001', %L, 4::smallint, '  Turned up on time  ')$$, current_setting('t.b1')),
  'the employer reviews the worker');
select lives_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000011', %L, 5::smallint, null)$$, current_setting('t.b1')),
  'the worker reviews the employer');
select throws_ok(format($$select public.submit_review('00000000-0000-0000-0000-000000000001', %L, 1::smallint, 'again')$$, current_setting('t.b1')),
  'KS409', 'already_reviewed', 'one review per booking and reviewer');
reset role;
select is((select count(*)::int from public.booking_reviews where booking_id = current_setting('t.b1')::uuid), 2, 'exactly two reviews exist');
select is((select reviewee_id::text from public.booking_reviews where booking_id = current_setting('t.b1')::uuid and reviewer_id = '00000000-0000-0000-0000-000000000001'),
  '00000000-0000-0000-0000-000000000011', 'the reviewee is derived from the booking, never supplied by the caller');
select is((select comment from public.booking_reviews where reviewer_id = '00000000-0000-0000-0000-000000000001'), 'Turned up on time', 'comment trimmed');

-- backstops that hold even without the RPC (as the table owner)
select throws_ok(format($$insert into public.booking_reviews (booking_id, reviewer_id, reviewee_id, rating) values (%L, '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 5)$$, current_setting('t.bf')),
  'KS409', 'booking_not_completed', 'a review without a completed booking is impossible');
select throws_ok(format($$insert into public.booking_reviews (booking_id, reviewer_id, reviewee_id, rating) values (%L, '00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 5)$$, current_setting('t.b1')),
  'KS403', 'review_parties_invalid', 'a review by someone outside the booking is impossible');
select throws_ok(format($$insert into public.booking_reviews (booking_id, reviewer_id, reviewee_id, rating) values (%L, '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', 5)$$, current_setting('t.b1')),
  'KS403', 'review_parties_invalid', 'nobody can review themselves (and the CHECK constraint backs this up)');
select throws_ok($$update public.booking_reviews set rating = 1$$, 'KS409', 'review_immutable', 'reviews cannot be edited');

-- RLS: you see only reviews you wrote or received
select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.booking_reviews), 2, 'a party sees both reviews of their own booking');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000014');
select is((select count(*)::int from public.booking_reviews), 0, 'a stranger sees no reviews');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.booking_reviews), 0, 'another employer sees no reviews');
select throws_ok($$insert into public.booking_reviews (booking_id, reviewer_id, reviewee_id, rating) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 5)$$, '42501', null, 'clients cannot insert reviews directly');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.booking_reviews$$, '42501', null, 'anon cannot read reviews');
reset role;

-- ===========================================================================
-- applicant evidence: facts, and new workers are not penalised
-- ===========================================================================
select set_config('t.j2', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '6 days')::text, true);
insert into public.job_applications (job_id, worker_id) values (current_setting('t.j2')::uuid, '00000000-0000-0000-0000-000000000011');
insert into public.job_applications (job_id, worker_id) values (current_setting('t.j2')::uuid, '00000000-0000-0000-0000-000000000012');
insert into public.job_applications (job_id, worker_id) values (current_setting('t.j2')::uuid, '00000000-0000-0000-0000-000000000014');
select pg_temp.as_service();
select is((select completed_jobs || '/' || no_show_count || '/' || review_count || '/' || avg_rating from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.j2')::uuid) where worker_id = '00000000-0000-0000-0000-000000000011'),
  '1/0/1/4.0', 'a worker with one completed, reviewed job: 1 completed, 0 no-shows, 1 review, average 4.0');
select is((select completed_jobs || '/' || no_show_count || '/' || review_count from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.j2')::uuid) where worker_id = '00000000-0000-0000-0000-000000000012'),
  '0/1/0', 'a worker with a recorded no-show shows it as a fact');
select is((select avg_rating from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.j2')::uuid) where worker_id = '00000000-0000-0000-0000-000000000014'),
  null, 'a brand-new worker has a NULL average (not zero): no history is never a bad rating');
select is((select review_count from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.j2')::uuid) where worker_id = '00000000-0000-0000-0000-000000000014'),
  0, 'and zero reviews');
reset role;

-- Cancellation attribution is untouched: the employer cancelling a future booking is still recorded as employer-caused
select pg_temp.as_service();
select lives_ok(format($$select public.cancel_booking('00000000-0000-0000-0000-000000000001', %L, 'rain')$$, current_setting('t.bf')), 'cancel_booking still works');
reset role;
select is((select status from public.bookings where id = current_setting('t.bf')::uuid), 'cancelled_by_employer', 'cancellation attribution preserved');
select is(pg_temp.pf(current_setting('t.fut')::uuid), '0/open', 'and the cancelled slot reopens as before');

-- in_progress: a worker who is already in progress cannot be recorded as a no-show (the state machine forbids it); completing is fine
select set_config('t.jp', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '-1 hour', interval '5 hours', 1::smallint)::text, true);
select set_config('t.bp', pg_temp.mk_booking(current_setting('t.jp')::uuid, '00000000-0000-0000-0000-000000000014')::text, true);
update public.bookings set status = 'in_progress' where id = current_setting('t.bp')::uuid;
select pg_temp.as_service();
select throws_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'no_show')$$, current_setting('t.bp')),
  'KS422', 'invalid_outcome', 'an in-progress booking cannot be marked no-show');
select lives_ok(format($$select public.finish_booking('00000000-0000-0000-0000-000000000001', %L, 'completed')$$, current_setting('t.bp')),
  'but it can be completed');
reset role;

select * from finish();
rollback;
