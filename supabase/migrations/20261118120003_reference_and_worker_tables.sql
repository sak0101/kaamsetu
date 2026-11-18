-- KaamSetu Phase 1 / migration 03
-- Reference tables, worker profile tables, and the signup trigger.

create table public.work_categories (
  id        smallint generated always as identity primary key,
  slug      text not null unique check (slug ~ '^[a-z0-9_]+$'),
  name_en   text not null,
  name_hi   text not null,
  name_gu   text not null,
  is_active boolean not null default true
);

create table public.localities (
  id        smallint generated always as identity primary key,
  city      text not null,
  name      text not null,
  is_active boolean not null default true,
  constraint localities_city_name_key unique (city, name)
);

-- Phase 1: one locality per worker. `role` is a generated constant so the
-- composite FK guarantees the row belongs to a *worker* profile.
create table public.worker_profiles (
  user_id          uuid primary key,
  role             text generated always as ('worker') stored,
  bio              text check (bio is null or char_length(bio) <= 500),
  years_experience smallint check (years_experience is null or years_experience between 0 and 60),
  locality_id      smallint references public.localities (id) on delete restrict,
  is_available     boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint worker_profiles_profile_fk
    foreign key (user_id, role) references public.profiles (id, role) on delete cascade
);

create table public.worker_categories (
  worker_id   uuid     not null references public.worker_profiles (user_id) on delete cascade,
  category_id smallint not null references public.work_categories (id) on delete restrict,
  primary key (worker_id, category_id)
);
create index worker_categories_category_idx on public.worker_categories (category_id, worker_id);
create index worker_profiles_locality_idx on public.worker_profiles (locality_id);

alter table public.work_categories  enable row level security;
alter table public.localities       enable row level security;
alter table public.worker_profiles  enable row level security;
alter table public.worker_categories enable row level security;

create trigger trg_worker_profiles_90_updated_at
  before update on public.worker_profiles
  for each row execute function private.set_updated_at();

-- Backstop for the 5-category cap (save_worker_profile validates first).
create function private.worker_categories_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.worker_categories where worker_id = new.worker_id) >= 5 then
    raise exception 'too_many_categories' using errcode = 'KS422';
  end if;
  return new;
end $$;

create trigger trg_worker_categories_10_cap
  before insert on public.worker_categories
  for each row execute function private.worker_categories_cap();

-- ---------------------------------------------------------------------------
-- Signup trigger. Runs inside Supabase Auth's transaction as supabase_auth_admin,
-- which cannot write to public tables, so it must be SECURITY DEFINER.
-- raw_user_meta_data is user-controlled: we only accept a whitelisted role
-- (never admin) and a bounded name. Invalid input aborts signup.
-- ---------------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := new.raw_user_meta_data ->> 'role';
  v_name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  if v_role is null or v_role not in ('worker', 'employer') then
    raise exception 'invalid_role' using errcode = 'KS422';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'invalid_full_name' using errcode = 'KS422';
  end if;

  insert into public.profiles (id, role, full_name) values (new.id, v_role, v_name);
  if v_role = 'worker' then
    insert into public.worker_profiles (user_id) values (new.id);
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
