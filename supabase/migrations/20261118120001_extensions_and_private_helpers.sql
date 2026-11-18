-- KaamSetu Phase 1 / migration 01
-- Extensions, the non-exposed `private` schema, default-deny privileges, and
-- internal helper functions.
--
-- SECURITY MODEL (summary; full text in docs/database.md)
--   * Express is the ONLY write path. The browser has SELECT (RLS) + Realtime only.
--   * Mutations are SECURITY DEFINER functions in `public`, executable by
--     `service_role` only, taking the actor uid as `p_actor`.
--   * Tables and functions are owned by `postgres`. RLS is ENABLED (not FORCED):
--     the owner (and therefore definer functions) bypasses RLS; client roles never
--     own anything, so RLS always applies to them.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;   -- RLS policies call private helpers

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Default privileges: new objects created by `postgres` are NOT granted to
-- anyone. Supabase's defaults grant ALL to anon/authenticated/service_role in
-- `public`; we remove that. Each object is then granted explicitly.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Generic trigger: maintain updated_at.
-- ---------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Backstop: client roles can never write to a table directly, even if a grant
-- is widened by mistake later. Fires as a STATEMENT trigger before any row work.
-- Inside SECURITY DEFINER functions current_user is the owner (postgres), so
-- legitimate writes pass.
-- ---------------------------------------------------------------------------
create function private.deny_client_writes() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'direct_writes_forbidden' using errcode = 'KS403';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Caller assertions used at the top of every API function.
-- ---------------------------------------------------------------------------

-- The request JWT role claim is set by PostgREST from a verified JWT.
-- EXECUTE grants already restrict API functions to service_role; this is a
-- second, independent check.
create function private.assert_service_caller() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role   text;
  v_claims text;
begin
  v_role := nullif(current_setting('request.jwt.claim.role', true), '');
  if v_role is null then
    v_claims := nullif(current_setting('request.jwt.claims', true), '');
    if v_claims is not null then
      v_role := v_claims::jsonb ->> 'role';
    end if;
  end if;
  if v_role is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = 'KS403';
  end if;
end $$;

-- Row-lock rechecks rely on READ COMMITTED (a fresh snapshot per statement).
create function private.assert_read_committed() returns void
language plpgsql set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'unsupported_isolation_level' using errcode = 'KS500';
  end if;
end $$;

-- Per-worker advisory lock. Re-entrant within a session; released at COMMIT or
-- ROLLBACK. Level 2 in the global lock order (see docs/database.md):
--   job row  <  worker advisory lock  <  application row  <  booking row
create function private.lock_worker(p_worker uuid) returns void
language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('kaamsetu:worker:' || p_worker::text, 0));
$$;
