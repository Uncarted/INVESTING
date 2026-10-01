-- Carteira — database setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
--
-- One row per user with their whole portfolio (assets, transactions, settings, API keys) as JSON.
-- Row Level Security guarantees each user can only read and write their own row.

create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;

drop policy if exists "portfolios: read own"   on public.portfolios;
drop policy if exists "portfolios: insert own" on public.portfolios;
drop policy if exists "portfolios: update own" on public.portfolios;
drop policy if exists "portfolios: delete own" on public.portfolios;

create policy "portfolios: read own"   on public.portfolios for select using (auth.uid() = user_id);
create policy "portfolios: insert own" on public.portfolios for insert with check (auth.uid() = user_id);
create policy "portfolios: update own" on public.portfolios for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "portfolios: delete own" on public.portfolios for delete using (auth.uid() = user_id);

-- AI document reading: how many documents each account read today (used by the
-- "read-document" Edge Function for its daily limit). Only the function can touch it.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
