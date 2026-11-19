-- Signup trigger, profile/worker functions, create_job, apply/withdraw/reject,
-- get_applicant_signals (evidence only).
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
create function pg_temp.mk_worker(p_id uuid, p_name text default 'Worker Test', p_loc smallint default 1,
                                  p_years smallint default 2) returns uuid
language plpgsql as $$
begin
  perform pg_temp.mk_user(p_id, 'worker', p_name);
  update public.worker_profiles set locality_id = p_loc, years_experience = p_years where user_id = p_id;
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
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
end $$;

-- ===========================================================================
-- Signup trigger
-- ===========================================================================
select pg_temp.mk_user('00000000-0000-0000-0000-000000000001'::uuid, 'employer', 'Employer One');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000002'::uuid, 'employer', 'Employer Two');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000011'::uuid, 'worker', 'Worker One');

select is((select role from public.profiles where id = '00000000-0000-0000-0000-000000000011'::uuid), 'worker', 'signup creates a worker profile');
select is((select count(*)::int from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011'::uuid), 1, 'worker signup creates worker_profiles row');
select is((select count(*)::int from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000001'::uuid), 0, 'employer signup creates no worker_profiles row');

select throws_ok($$insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  (gen_random_uuid(), 'authenticated', 'authenticated', 'a@test.invalid', '{"role":"admin","full_name":"Evil Admin"}')$$,
  'KS422', 'invalid_role', 'signup with role=admin is rejected');
select throws_ok($$insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  (gen_random_uuid(), 'authenticated', 'authenticated', 'b@test.invalid', '{"full_name":"No Role"}')$$,
  'KS422', 'invalid_role', 'signup without a role is rejected');
select throws_ok($$insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  (gen_random_uuid(), 'authenticated', 'authenticated', 'c@test.invalid', '{"role":"worker","full_name":"X"}')$$,
  'KS422', 'invalid_full_name', 'signup with a too-short name is rejected');

select throws_ok($$update public.profiles set role = 'employer' where id = '00000000-0000-0000-0000-000000000011'$$,
  'KS403', 'profile_identity_immutable', 'profile role is immutable even for the owner');

-- ===========================================================================
-- update_profile / save_worker_profile
-- ===========================================================================
select pg_temp.as_service();
select lives_ok($$select public.update_profile('00000000-0000-0000-0000-000000000001'::uuid, '  Employer Renamed ', 'gu', 'Shree Traders')$$, 'employer updates profile');
select lives_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011'::uuid, 'Worker Renamed', 'hi', 'Should Be Dropped')$$, 'worker updates profile');
select throws_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011'::uuid, 'Worker Renamed', 'fr', null)$$, '23514', null, 'invalid language rejected');
select throws_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011'::uuid, 'X', 'en', null)$$, '23514', null, 'too-short name rejected');
select throws_ok($$select public.update_profile(gen_random_uuid(), 'Nobody Here', 'en', null)$$, 'KS401', 'unauthenticated', 'unknown actor rejected');
select throws_ok($$select public.update_profile(null, 'Nobody Here', 'en', null)$$, 'KS401', 'unauthenticated', 'null actor rejected');
reset role;
select is((select full_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'::uuid), 'Employer Renamed', 'name trimmed and saved');
select is((select org_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'::uuid), 'Shree Traders', 'employer org_name saved');
select is((select org_name from public.profiles where id = '00000000-0000-0000-0000-000000000011'::uuid), null, 'worker org_name is forced to null');
select is((select preferred_language from public.profiles where id = '00000000-0000-0000-0000-000000000011'::uuid), 'hi', 'language saved');

select pg_temp.as_service();
select lives_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, 'Strong and punctual', 4::smallint, 2::smallint, true, array[1,2,2,3]::smallint[])$$,
  'worker saves profile with categories (duplicates collapse)');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, null, null, 1::smallint, true, array[1,2,3,4,5,6]::smallint[])$$,
  'KS422', 'too_many_categories', 'more than 5 categories rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, null, null, 1::smallint, true, array[999]::smallint[])$$,
  'KS422', 'invalid_category', 'unknown category rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, null, null, 999::smallint, true, null)$$,
  'KS422', 'invalid_locality', 'unknown locality rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, null, 99::smallint, 1::smallint, true, null)$$,
  '23514', null, 'years_experience out of range rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000001'::uuid, null, null, 1::smallint, true, null)$$,
  'KS403', 'wrong_role', 'an employer cannot save a worker profile');
reset role;
select is((select array_agg(category_id order by category_id) from public.worker_categories where worker_id = '00000000-0000-0000-0000-000000000011'::uuid),
  array[1,2,3]::smallint[], 'categories stored (deduplicated)');
select is((select locality_id from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011'::uuid), 2::smallint, 'locality stored');

select pg_temp.as_service();
select lives_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011'::uuid, 'Strong and punctual', 4::smallint, 2::smallint, true, array[5]::smallint[])$$,
  'categories can be replaced');
reset role;
select is((select array_agg(category_id) from public.worker_categories where worker_id = '00000000-0000-0000-0000-000000000011'::uuid),
  array[5]::smallint[], 'categories replaced, not appended');

-- ===========================================================================
-- create_job
-- ===========================================================================
select pg_temp.as_service();
select lives_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Two flights of stairs',
  now() + interval '1 day', now() + interval '1 day 4 hours', 2::smallint, 'daily', 90000)$$, 'employer creates a job');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000011'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 90000)$$, 'KS403', 'wrong_role', 'worker cannot create jobs');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() - interval '1 hour', now() + interval '2 hours', 1::smallint, 'daily', 90000)$$, 'KS422', 'starts_at_must_be_future', 'past start rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '2 days', now() + interval '1 day', 1::smallint, 'daily', 90000)$$, 'KS422', 'ends_at_must_follow_starts_at', 'end before start rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '16 days', 1::smallint, 'daily', 90000)$$, '23514', null, 'duration over 14 days rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 0)$$, '23514', null, 'zero pay rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 9000000)$$, '23514', null, 'pay above INR 50,000 rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 0::smallint, 'daily', 90000)$$, '23514', null, 'zero workers rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'weekly', 90000)$$, '23514', null, 'unknown pay_type rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 99::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 90000)$$, 'KS422', 'invalid_category', 'bad category rejected');
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 99::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 90000)$$, 'KS422', 'invalid_locality', 'bad locality rejected');
reset role;
select is((select count(*)::int from public.jobs where employer_id = '00000000-0000-0000-0000-000000000001'::uuid), 1, 'only the valid job exists');
select is((select status from public.jobs where employer_id = '00000000-0000-0000-0000-000000000001'::uuid), 'open', 'created job is open');

-- ===========================================================================
-- apply_to_job / withdraw_application / reject_application
-- ===========================================================================
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000012'::uuid, 'Worker Two');
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000013'::uuid, 'Worker Three', 5::smallint, null);
select set_config('t.job', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '2 days')::text, true);
select set_config('t.jstarted', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '-1 hour')::text, true);

-- W11 profile is complete (saved above); fresh incomplete worker:
select pg_temp.mk_user('00000000-0000-0000-0000-000000000014'::uuid, 'worker', 'Worker Bare');   -- no locality, no categories

select pg_temp.as_service();
select lives_ok($$select set_config('t.app12', public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.job')::uuid, 'I can start early')::text, true)$$,
  'worker applies');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.job')::uuid, null)$$, 'KS409', 'already_applied', 'duplicate application rejected');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.job')::uuid, null)$$, 'KS403', 'wrong_role', 'employer cannot apply');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, gen_random_uuid(), null)$$, 'KS404', 'job_not_found', 'unknown job rejected');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.jstarted')::uuid, null)$$, 'KS409', 'job_not_open', 'started job rejected');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000014'::uuid, current_setting('t.job')::uuid, null)$$, 'KS422', 'worker_profile_incomplete', 'incomplete profile rejected');
select lives_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000013'::uuid, current_setting('t.job')::uuid, null)$$, 'second worker applies');
reset role;

select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000001'::uuid and type = 'new_application'), 2,
  'employer was notified of both applications');

update public.worker_profiles set is_available = false where user_id = '00000000-0000-0000-0000-000000000011'::uuid;
select pg_temp.as_service();
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000011'::uuid, current_setting('t.job')::uuid, null)$$, 'KS409', 'worker_not_available', 'unavailable worker rejected');
reset role;
update public.worker_profiles set is_available = true where user_id = '00000000-0000-0000-0000-000000000011'::uuid;

-- withdraw / re-apply
select pg_temp.as_service();
select throws_ok($$select public.withdraw_application('00000000-0000-0000-0000-000000000013'::uuid, current_setting('t.app12')::uuid)$$, 'KS404', 'application_not_found', 'cannot withdraw someone else''s application');
select lives_ok($$select public.withdraw_application('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.app12')::uuid)$$, 'worker withdraws');
select throws_ok($$select public.withdraw_application('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.app12')::uuid)$$, 'KS409', 'application_not_pending', 'cannot withdraw twice');
select lives_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.job')::uuid, 'Back again')$$, 're-apply after withdrawal works');
reset role;
select is((select status from public.job_applications where id = current_setting('t.app12')::uuid), 'pending', 're-apply reuses the row and returns it to pending');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000001'::uuid and type = 'new_application'), 3, 're-apply notifies the employer again');

-- reject
select pg_temp.as_service();
select throws_ok($$select public.reject_application('00000000-0000-0000-0000-000000000002'::uuid, current_setting('t.app12')::uuid, null)$$, 'KS404', 'application_not_found', 'other employer cannot reject');
select throws_ok($$select public.reject_application('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.app12')::uuid, null)$$, 'KS403', 'wrong_role', 'worker cannot reject');
select lives_ok($$select public.reject_application('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.app12')::uuid, 'Not a fit')$$, 'owner rejects');
select throws_ok($$select public.reject_application('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.app12')::uuid, null)$$, 'KS409', 'application_not_pending', 'cannot reject twice');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.job')::uuid, null)$$, 'KS409', 'already_applied', 'rejected worker cannot re-apply');
reset role;
select is((select status_reason from public.job_applications where id = current_setting('t.app12')::uuid), 'Not a fit', 'reject reason stored');
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-000000000012'::uuid and type = 'application_rejected'), 1, 'worker notified of rejection');

-- state machine
select throws_ok($$update public.job_applications set status = 'pending' where id = current_setting('t.app12')::uuid$$,
  'KS409', 'invalid_application_transition', 'rejected -> pending is not allowed');
select throws_ok($$update public.job_applications set status = 'accepted' where id = current_setting('t.app12')::uuid$$,
  'KS409', 'invalid_application_transition', 'rejected -> accepted is not allowed');

-- pending cap of 20
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000015'::uuid, 'Worker Cap');
select pg_temp.mk_job('00000000-0000-0000-0000-000000000002'::uuid, (g || ' days')::interval + interval '5 days') from generate_series(1, 21) g;
select set_config('t.capjobs', (select string_agg(id::text, ',' order by starts_at) from (select id, starts_at from public.jobs where employer_id = '00000000-0000-0000-0000-000000000002'::uuid order by starts_at limit 20) s), true);
select set_config('t.caplast', (select id::text from public.jobs where employer_id = '00000000-0000-0000-0000-000000000002'::uuid order by starts_at desc limit 1), true);
select pg_temp.as_service();
select lives_ok($sql$do $b$ declare r text; begin
  foreach r in array string_to_array(current_setting('t.capjobs'), ',') loop
    perform public.apply_to_job('00000000-0000-0000-0000-000000000015'::uuid, r::uuid, null);
  end loop; end $b$$sql$, 'worker can hold 20 pending applications');
select throws_ok($$select public.apply_to_job('00000000-0000-0000-0000-000000000015'::uuid, current_setting('t.caplast')::uuid, null)$$,
  'KS409', 'too_many_pending', 'the 21st pending application is rejected');
reset role;

-- ===========================================================================
-- get_applicant_signals: evidence only
-- ===========================================================================
select pg_temp.mk_worker('00000000-0000-0000-0000-000000000016'::uuid, 'Worker Six');                                    -- cat 1, locality 1, years 2
select set_config('t.sjob', pg_temp.mk_job('00000000-0000-0000-0000-000000000001'::uuid, interval '4 days')::text, true);  -- category 1, locality 1
select pg_temp.as_service();
select public.apply_to_job('00000000-0000-0000-0000-000000000013'::uuid, current_setting('t.sjob')::uuid, 'third');   -- cat 1, locality 5, years null
select public.apply_to_job('00000000-0000-0000-0000-000000000016'::uuid, current_setting('t.sjob')::uuid, 'sixth');   -- cat 1, locality 1, years 2
reset role;
update public.worker_profiles set locality_id = null where user_id = '00000000-0000-0000-0000-000000000013'::uuid;
insert into public.worker_categories (worker_id, category_id) values ('00000000-0000-0000-0000-000000000016'::uuid, 2) on conflict do nothing;
delete from public.worker_categories where worker_id = '00000000-0000-0000-0000-000000000016'::uuid and category_id = 1;   -- W16 no longer matches category 1

select pg_temp.as_service();
select is((select count(*)::int from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid)), 2, 'owner gets both applicants');
select is((select category_match from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000013'::uuid), true, 'category match true');
select is((select category_match from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000016'::uuid), false, 'category match false');
select is((select locality_match from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000013'::uuid), 'unknown', 'locality unknown when worker has none');
select is((select locality_match from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000016'::uuid), 'same_locality', 'locality same');
select is((select years_experience from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000013'::uuid), null, 'missing experience stays NULL (not 0)');
select is((select years_experience from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid) where worker_id = '00000000-0000-0000-0000-000000000016'::uuid), 2::smallint, 'experience shown');
reset role;
update public.job_applications set created_at = now() - interval '1 hour'
 where job_id = current_setting('t.sjob')::uuid and worker_id = '00000000-0000-0000-0000-000000000016'::uuid;
select pg_temp.as_service();
select is((select array_agg(worker_id) from public.get_applicant_signals('00000000-0000-0000-0000-000000000001'::uuid, current_setting('t.sjob')::uuid)),
  array['00000000-0000-0000-0000-000000000016'::uuid, '00000000-0000-0000-0000-000000000013'::uuid],
  'applicants are listed by application time (earliest first), not by any quality measure');
select throws_ok($$select * from public.get_applicant_signals('00000000-0000-0000-0000-000000000002'::uuid, current_setting('t.sjob')::uuid)$$, 'KS404', 'job_not_found', 'other employer cannot read applicant evidence');
select throws_ok($$select * from public.get_applicant_signals('00000000-0000-0000-0000-000000000012'::uuid, current_setting('t.sjob')::uuid)$$, 'KS403', 'wrong_role', 'worker cannot read applicant evidence');
reset role;

-- Migration 15 adds genuine review FACTS (review_count, avg_rating from completed bookings, null when none). There
-- is still no computed score, reliability figure, rank, quality or prediction column.
-- Strict: the only column allowed to contain "rating" is exactly avg_rating (a plain average of genuine reviews).
select doesnt_match(replace(pg_get_function_result('public.get_applicant_signals(uuid,uuid)'::regprocedure), 'avg_rating numeric', ''),
  '(?i)(rating|score|reliab|rank|predict|quality)', 'applicant evidence exposes no rating, score, reliability, rank or prediction column except the plain avg_rating fact');
select is(pg_get_function_result('public.get_applicant_signals(uuid,uuid)'::regprocedure),
  'TABLE(application_id uuid, worker_id uuid, worker_name text, application_status text, applied_at timestamp with time zone, message text, category_match boolean, locality_match text, years_experience smallint, has_booking_conflict boolean, bio text, skills text[], availability_note text, member_since timestamp with time zone, completed_jobs integer, no_show_count integer, review_count integer, avg_rating numeric)',
  'applicant evidence columns are exactly the documented set');

-- suspended actors are refused
update public.profiles set is_suspended = true where id = '00000000-0000-0000-0000-000000000001'::uuid;
select pg_temp.as_service();
select throws_ok($$select public.create_job('00000000-0000-0000-0000-000000000001'::uuid, 1::smallint, 1::smallint, 'Move a sofa set', 'Desc',
  now() + interval '1 day', now() + interval '2 days', 1::smallint, 'daily', 90000)$$, 'KS403', 'account_suspended', 'suspended employer cannot create jobs');
reset role;

select * from finish();
rollback;
