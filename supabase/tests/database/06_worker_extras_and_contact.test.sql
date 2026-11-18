-- Phase 1b: worker skills / availability note, contact phone privacy, richer applicant evidence.
-- Fixture ids: E1=...01 E2=...02, W1=...11 W2=...12 W3=...13
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
-- Skills and availability note
-- ===========================================================================
select pg_temp.as_service();
select lives_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', 'Reliable', 3::smallint, 1::smallint, true,
  array[1]::smallint[], array['  Guest handling ', 'stage setup', 'Guest Handling', 'Hindi', 'Gujarati'], 'Evenings and weekends')$$,
  'worker saves skills and an availability note');
reset role;
select is((select skills from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011'),
  array['Guest handling', 'stage setup', 'Hindi', 'Gujarati'], 'skills are trimmed and de-duplicated case-insensitively, order kept');
select is((select availability_note from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011'),
  'Evenings and weekends', 'availability note stored');

select pg_temp.as_service();
select lives_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', 'Reliable', 3::smallint, 1::smallint, true, null, null, null)$$,
  'saving without skills leaves them unchanged');
reset role;
select is(cardinality((select skills from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011')), 4,
  'NULL skills means unchanged, not cleared');
select is((select availability_note from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011'), null,
  'the availability note is overwritten (cleared) when omitted');

select pg_temp.as_service();
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', null, null, 1::smallint, true, null,
  array['a','b','c','d','e','f','g','h','i9'], null)$$, 'KS422', 'invalid_skills', 'more than 8 skills rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', null, null, 1::smallint, true, null,
  array['x'], null)$$, 'KS422', 'invalid_skills', 'a 1-character skill rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', null, null, 1::smallint, true, null,
  array[repeat('y', 41)], null)$$, 'KS422', 'invalid_skills', 'a 41-character skill rejected');
select throws_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', null, null, 1::smallint, true, null,
  null, repeat('z', 121))$$, '23514', null, 'an over-long availability note rejected');
select lives_ok($$select public.save_worker_profile('00000000-0000-0000-0000-000000000011', null, null, 1::smallint, true, null, array[]::text[], null)$$,
  'an empty array clears skills');
reset role;
select is(cardinality((select skills from public.worker_profiles where user_id = '00000000-0000-0000-0000-000000000011')), 0, 'skills cleared by an empty array');

-- ===========================================================================
-- Contact phone: validation and normalisation
-- ===========================================================================
select pg_temp.as_service();
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '98765 43210')$$, 'a 10-digit mobile number is accepted');
reset role;
select is((select phone from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), '+919876543210', 'stored in E.164 form');

select pg_temp.as_service();
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '+91-98765-43211')$$, '+91 with dashes accepted');
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '09876543212')$$, 'a leading 0 is accepted');
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '919876543213')$$, 'a leading 91 is accepted');
reset role;
select is((select phone from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), '+919876543213', 'the latest number wins (upsert)');

select pg_temp.as_service();
select throws_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '12345')$$, 'KS422', 'invalid_phone', 'too short rejected');
select throws_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '5876543210')$$, 'KS422', 'invalid_phone', 'must start 6-9');
select throws_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', 'call me maybe')$$, 'KS422', 'invalid_phone', 'letters rejected');
select throws_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '+14155552671')$$, 'KS422', 'invalid_phone', 'a non-Indian number is rejected');
select throws_ok($$select public.save_contact(gen_random_uuid(), '9876543210')$$, 'KS401', 'unauthenticated', 'unknown actor rejected');
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000001', '9123456789')$$, 'employers may save a number too');
reset role;

-- ===========================================================================
-- Contact phone privacy (RLS): only the owner, or the other side of a LIVE booking
-- ===========================================================================
select pg_temp.mk_user('00000000-0000-0000-0000-000000000099', 'worker', 'Outsider');
select set_config('t.job', pg_temp.mk_job('00000000-0000-0000-0000-000000000001', interval '3 days')::text, true);
select pg_temp.as_service();
select set_config('t.a11', public.apply_to_job('00000000-0000-0000-0000-000000000011', current_setting('t.job')::uuid, null)::text, true);
select set_config('t.a12', public.apply_to_job('00000000-0000-0000-0000-000000000012', current_setting('t.job')::uuid, null)::text, true);
reset role;

-- Applicants (no booking yet): the employer must NOT see a worker's number.
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), 0,
  'an employer cannot see an APPLICANT''s phone before booking');
select is((select count(*)::int from public.contact_details where user_id <> '00000000-0000-0000-0000-000000000001'), 0, 'employer sees only their own number so far');
reset role;

select pg_temp.as_service();
select lives_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', current_setting('t.a11')::uuid)$$, 'employer books worker 11');
reset role;
select set_config('t.b11', (select id::text from public.bookings where worker_id = '00000000-0000-0000-0000-000000000011'), true);

select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select is((select phone from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), '+919876543213',
  'once booked, the employer can see the booked worker''s phone');
select is((select count(*)::int from public.contact_details where user_id = '00000000-0000-0000-0000-000000000012'), 0,
  'but not the phone of a different (merely applied / rejected) worker');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select is((select phone from public.contact_details where user_id = '00000000-0000-0000-0000-000000000001'), '+919123456789',
  'the booked worker can see their employer''s phone');
select is((select count(*)::int from public.contact_details), 2, 'the worker sees exactly their own and their employer''s numbers');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-000000000012');
select is((select count(*)::int from public.contact_details where user_id <> '00000000-0000-0000-0000-000000000012'), 0, 'an unbooked worker sees nobody else''s number');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000099');
select is((select count(*)::int from public.contact_details), 0, 'a stranger sees no numbers at all');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.contact_details where user_id <> '00000000-0000-0000-0000-000000000002'), 0, 'another employer sees no worker numbers');
reset role;

-- Sharing ends with the booking.
select pg_temp.as_service();
select public.cancel_booking('00000000-0000-0000-0000-000000000011', current_setting('t.b11')::uuid, null);
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), 0, 'after cancellation the employer can no longer see the number');
reset role;

-- No client writes, no anonymous reads.
select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select throws_ok($$insert into public.contact_details (user_id, phone) values ('00000000-0000-0000-0000-000000000011', '+919999999999')$$, '42501'::char(5), null, 'clients cannot write contact_details directly');
select throws_ok($$update public.contact_details set phone = '+919999999999'$$, '42501'::char(5), null, 'clients cannot update contact_details');
select throws_ok($$delete from public.contact_details$$, '42501'::char(5), null, 'clients cannot delete contact_details');
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select count(*) from public.contact_details$$, '42501'::char(5), null, 'anon cannot read contact_details');
reset role;
select pg_temp.as_service();
select throws_ok($$select count(*) from public.contact_details$$, '42501'::char(5), null, 'service_role cannot read contact_details directly');
select lives_ok($$select public.save_contact('00000000-0000-0000-0000-000000000011', '')$$, 'an empty number clears the stored one');
reset role;
select is((select count(*)::int from public.contact_details where user_id = '00000000-0000-0000-0000-000000000011'), 0, 'number removed');

-- ===========================================================================
-- Applicant evidence now includes bio / skills / availability / member-since / completed jobs
-- ===========================================================================
select pg_temp.as_service();
select public.save_worker_profile('00000000-0000-0000-0000-000000000012', 'I do weddings', 1::smallint, 1::smallint, true, null, array['Serving'], 'Weekends');
select is((select skills from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.job')::uuid)
            where worker_id = '00000000-0000-0000-0000-000000000012'), array['Serving'], 'signals include skills');
select is((select bio || '|' || availability_note from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.job')::uuid)
            where worker_id = '00000000-0000-0000-0000-000000000012'), 'I do weddings|Weekends', 'signals include bio and availability note');
select is((select completed_jobs from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.job')::uuid)
            where worker_id = '00000000-0000-0000-0000-000000000012'), 0, 'a new worker has 0 completed jobs: reported as a fact, never fabricated');
select isnt((select member_since from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.job')::uuid)
              where worker_id = '00000000-0000-0000-0000-000000000012'), null, 'signals include member_since');
reset role;

insert into public.job_applications (job_id, worker_id, status, decided_at)
  select pg_temp.mk_job('00000000-0000-0000-0000-000000000002', interval '20 days'), '00000000-0000-0000-0000-000000000013', 'accepted', now();
insert into public.bookings (job_id, application_id, worker_id, employer_id, work_period, agreed_pay_paise)
  select j.id, a.id, '00000000-0000-0000-0000-000000000013', j.employer_id, j.work_period, j.pay_amount_paise
    from public.job_applications a join public.jobs j on j.id = a.job_id
   where a.worker_id = '00000000-0000-0000-0000-000000000013' and j.employer_id = '00000000-0000-0000-0000-000000000002';
update public.bookings set status = 'completed', completed_at = now() where worker_id = '00000000-0000-0000-0000-000000000013';
select pg_temp.as_service();
select public.apply_to_job('00000000-0000-0000-0000-000000000013', current_setting('t.job')::uuid, null);
select is((select completed_jobs from public.get_applicant_signals('00000000-0000-0000-0000-000000000001', current_setting('t.job')::uuid)
            where worker_id = '00000000-0000-0000-0000-000000000013'), 1, 'a genuinely completed booking is counted');
reset role;

select * from finish();
rollback;
