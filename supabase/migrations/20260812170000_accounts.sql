create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.account_sessions (
  token_hash text primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.account_data (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  services jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.accounts enable row level security;
alter table public.account_sessions enable row level security;
alter table public.account_data enable row level security;
revoke all on public.accounts, public.account_sessions, public.account_data from anon, authenticated;
