-- KaamSetu Phase 1 / migration 06: notifications
-- Written only by private.notify() (called from triggers). Payloads carry no
-- phone numbers or addresses.

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  type        text not null check (type in
                ('new_application', 'application_rejected', 'booking_confirmed', 'booking_cancelled')),
  entity_type text not null check (entity_type in ('job_application', 'booking')),
  entity_id   uuid not null,
  payload     jsonb not null default '{}'::jsonb check (pg_column_size(payload) < 2000),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

create function private.notify(
  p_user uuid, p_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, type, entity_type, entity_id, payload)
  values (p_user, p_type, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb));
$$;
