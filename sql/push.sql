-- Push notification storage. Safe to re-run.
--
-- push_tokens: one row per device per user, written by the iOS app at login
-- and read by the daily-reminder Edge Function (service role).
-- profiles.timezone: IANA zone saved by the app so the reminder can check
-- "worked out today" against the user's own calendar day.

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null,
  platform text,
  created_at timestamptz not null default now(),
  unique (user_id, token)
);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens_own" on public.push_tokens;
create policy "push_tokens_own" on public.push_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.profiles add column if not exists timezone text;
-- Local date of the last reminder sent, so a late cron run can't double-send.
alter table public.profiles add column if not exists last_reminded_on text;

-- If hide_emails.sql has already run, profiles is readable column-by-column,
-- so the new column needs its own grant.
grant select (timezone) on public.profiles to anon, authenticated;
