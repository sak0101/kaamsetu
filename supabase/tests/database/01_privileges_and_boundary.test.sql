-- Privilege model and the service-role boundary.
--   * RLS on every table; exact function inventory; exact ACLs.
--   * authenticated / anon cannot execute any mutation function.
--   * service_role cannot perform ANY table DML (nor SELECT).
--   * client roles cannot write even if a grant is widened (backstop trigger).
--   * API functions reject callers whose JWT role claim is not service_role.
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
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end $$;

select pg_temp.mk_user('00000000-0000-0000-0000-000000000011', 'worker', 'Worker One');
select pg_temp.mk_user('00000000-0000-0000-0000-000000000001', 'employer', 'Employer One');

-- Informational: the owner's RLS bypass (definer functions rely on being the owner).
select diag('postgres rolbypassrls=' || (select rolbypassrls::text from pg_roles where rolname = 'postgres'));

-- ---------------------------------------------------------------------------
-- Inventory and ACLs
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity), 0,
          'RLS is enabled on every public table');

select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  array['accept_application', 'apply_to_job', 'cancel_booking', 'cancel_job', 'create_job',
        'get_applicant_signals', 'mark_notifications_read', 'reject_application',
        'save_contact', 'save_worker_profile', 'update_profile', 'withdraw_application'],
  'public schema exposes exactly the 12 API functions');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('public', p.oid, 'execute'))),
  0, 'no API function is executable by anon, authenticated or PUBLIC');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  0, 'every API function is executable by service_role');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute')
        or has_function_privilege('public', p.oid, 'execute'))),
  0, 'private functions are not executable by anon, service_role or PUBLIC');

select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'execute')),
  array['app_role', 'can_view_user', 'has_active_booking_with', 'has_applied', 'has_booking_on_job', 'owns_job'],
  'authenticated may execute only the RLS helpers in private (no trigger or internal functions)');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')),
  0, 'every SECURITY DEFINER function pins search_path to empty');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname in ('public', 'private') and r.rolname <> 'postgres'),
  0, 'all functions are owned by postgres');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where n.nspname = 'public' and c.relkind = 'r' and r.rolname <> 'postgres'),
  0, 'all tables are owned by postgres');

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('service_role')) r(rolname)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege(r.rolname, c.oid, p.priv)
        or has_any_column_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))),
  0, 'anon and service_role hold no table or column privileges at all');

select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('authenticated', c.oid, p.priv)
        or (p.priv in ('INSERT', 'UPDATE', 'REFERENCES')
            and has_any_column_privilege('authenticated', c.oid, p.priv)))),
  0, 'authenticated has no write privileges on any table or column');

select is(
  (select array_agg(c.relname::text order by c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', c.oid, 'SELECT')),
  array['bookings', 'contact_details', 'job_applications', 'jobs', 'localities', 'notifications',
        'work_categories', 'worker_categories', 'worker_profiles'],
  'authenticated has table-level SELECT on exactly the browser-readable tables');

select ok(not has_column_privilege('authenticated', 'public.profiles', 'is_suspended', 'SELECT'),
          'authenticated cannot read profiles.is_suspended');
select ok(has_column_privilege('authenticated', 'public.profiles', 'full_name', 'SELECT'),
          'authenticated can read profiles.full_name');

-- ---------------------------------------------------------------------------
-- authenticated and anon cannot execute any mutation function
-- ---------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select throws_ok(
  format('select public.%I(%s)', p.proname, array_to_string(array_fill('null'::text, array[p.pronargs::int]), ',')),
  '42501'::char(5), null, 'authenticated cannot execute ' || p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
 order by p.proname;

select throws_ok($$select public.accept_application('00000000-0000-0000-0000-000000000001', gen_random_uuid())$$,
  '42501'::char(5), null, 'authenticated cannot call accept_application even as a real employer');
select throws_ok($$select private.lock_worker('00000000-0000-0000-0000-000000000011')$$,
  '42501'::char(5), null, 'authenticated cannot call private.lock_worker');
select throws_ok($$select private.notify('00000000-0000-0000-0000-000000000011','new_application','booking',gen_random_uuid(),'{}')$$,
  '42501'::char(5), null, 'authenticated cannot call private.notify');
reset role;

select pg_temp.as_anon();
select throws_ok(
  format('select public.%I(%s)', p.proname, array_to_string(array_fill('null'::text, array[p.pronargs::int]), ',')),
  '42501'::char(5), null, 'anon cannot execute ' || p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
 order by p.proname;
reset role;

-- ---------------------------------------------------------------------------
-- service_role cannot perform direct table access (DML or SELECT)
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select throws_ok(format('insert into public.%I default values', t.name), '42501'::char(5), null,
                 'service_role cannot INSERT into ' || t.name)
  from (values ('profiles'), ('worker_profiles'), ('worker_categories'), ('work_categories'), ('localities'),
               ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
select throws_ok(format('update public.%I set id = id', t.name), '42501'::char(5), null,
                 'service_role cannot UPDATE ' || t.name)
  from (values ('profiles'), ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
select throws_ok(format('delete from public.%I', t.name), '42501'::char(5), null,
                 'service_role cannot DELETE from ' || t.name)
  from (values ('profiles'), ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
select throws_ok(format('select count(*) from public.%I', t.name), '42501'::char(5), null,
                 'service_role cannot SELECT from ' || t.name)
  from (values ('profiles'), ('jobs'), ('job_applications'), ('bookings'), ('notifications')) t(name);
reset role;

-- ---------------------------------------------------------------------------
-- Backstop: even if a write grant is widened, client roles still cannot write.
-- ---------------------------------------------------------------------------
grant insert, update, delete on public.profiles, public.jobs, public.bookings to authenticated, service_role;

select pg_temp.as_user('00000000-0000-0000-0000-000000000011');
select throws_ok($$update public.profiles set full_name = 'Hacked Name' where id = '00000000-0000-0000-0000-000000000011'$$,
  'KS403', 'direct_writes_forbidden', 'backstop: authenticated UPDATE on profiles denied even with a grant');
select throws_ok($$update public.profiles set role = 'employer' where id = '00000000-0000-0000-0000-000000000011'$$,
  'KS403', 'direct_writes_forbidden', 'backstop: authenticated cannot change own role even with a grant');
select throws_ok($$update public.profiles set is_suspended = false where id = '00000000-0000-0000-0000-000000000011'$$,
  'KS403', 'direct_writes_forbidden', 'backstop: authenticated cannot touch is_suspended even with a grant');
select throws_ok($$insert into public.bookings default values$$,
  'KS403', 'direct_writes_forbidden', 'backstop: authenticated INSERT on bookings denied even with a grant');
select throws_ok($$delete from public.jobs$$,
  'KS403', 'direct_writes_forbidden', 'backstop: authenticated DELETE on jobs denied even with a grant');
reset role;

select pg_temp.as_service();
select throws_ok($$update public.bookings set status = 'completed'$$,
  'KS403', 'direct_writes_forbidden', 'backstop: service_role UPDATE on bookings denied even with a grant');
reset role;

revoke insert, update, delete on public.profiles, public.jobs, public.bookings from authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The JWT role claim is checked independently of EXECUTE grants.
-- (postgres can execute everything, so this isolates the claim check.)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', null, true);
select throws_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011','Worker One','en',null)$$,
  'KS403', 'forbidden', 'no JWT claims: API function refuses');
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000011"}', true);
select throws_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011','Worker One','en',null)$$,
  'KS403', 'forbidden', 'authenticated JWT claim: API function refuses');
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011','Worker One','en',null)$$,
  'KS403', 'forbidden', 'anon JWT claim: API function refuses');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok($$select public.update_profile('00000000-0000-0000-0000-000000000011','Worker One','en',null)$$,
  'service_role claim: API function runs');

select * from finish();
rollback;
