-- KaamSetu Phase 1 / migration 02: profiles
-- One row per auth user. role is chosen at signup and is immutable.
-- No Aadhaar, DOB, gender or address data is stored anywhere.

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  role               text not null check (role in ('worker', 'employer')),
  full_name          text not null check (char_length(full_name) between 2 and 80),
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi', 'gu')),
  org_name           text check (org_name is null or char_length(org_name) between 1 and 100),
  is_suspended       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint profiles_id_role_key unique (id, role),
  constraint profiles_org_name_employer_only check (role = 'employer' or org_name is null)
);

alter table public.profiles enable row level security;

-- Identity columns are immutable for everyone (the owner would have to disable
-- the trigger deliberately). is_suspended is changeable only by the owner /
-- definer functions; the deny_client_writes backstop covers client roles.
create function private.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.role <> old.role then
    raise exception 'profile_identity_immutable' using errcode = 'KS403';
  end if;
  return new;
end $$;

create trigger trg_profiles_10_guard
  before update on public.profiles
  for each row execute function private.profiles_guard();

create trigger trg_profiles_90_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();
