create extension if not exists pgcrypto;

create table if not exists public.desktop_instances (
  desktop_id text primary key,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.paired_devices (
  device_id text primary key,
  desktop_id text not null references public.desktop_instances(desktop_id) on delete cascade,
  token_hash text not null,
  device_name text,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.relay_events (
  id bigint generated always as identity primary key,
  desktop_id text,
  device_id text,
  event_type text not null,
  created_at timestamptz not null default now()
);

alter table public.desktop_instances enable row level security;
alter table public.paired_devices enable row level security;
alter table public.relay_events enable row level security;

revoke all on public.desktop_instances from anon, authenticated;
revoke all on public.paired_devices from anon, authenticated;
revoke all on public.relay_events from anon, authenticated;
