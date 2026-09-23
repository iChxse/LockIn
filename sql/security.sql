-- Security hardening. Safe to re-run, and safe to run before the matching
-- app update (it only adds things). Hiding emails is a separate step in
-- hide_emails.sql because it breaks older app versions.
--
-- Profiles, workouts, etc. stay publicly viewable by design; what's locked
-- down here is private data and abuse:
--   1. profiles.email is filled from the auth record, never from the app.
--   2. Username login only reveals an email once the password checks out,
--      with a lockout after repeated failures.
--   3. Per-user write rate limits so no one can spam inserts.
--   4. Avatar uploads capped in size and type.

-- ── 0. Missing column the Settings screen already saves ──────────────────
alter table public.profiles add column if not exists default_sets int;

-- ── 1. profiles.email comes from auth, not the app ───────────────────────
-- Keeps the column filled (and unspoofable) for any server-side jobs.
-- Only pre-1.5.6 app builds still send email, via a login-time upsert that
-- would overwrite the display name once they can't read profiles; keep it.
create or replace function public.profiles_fill_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select u.email into new.email from auth.users u where u.id = new.id;
  if tg_op = 'UPDATE' then new.name := old.name; end if;
  return new;
end;
$$;

drop trigger if exists profiles_fill_email on public.profiles;
create trigger profiles_fill_email
  before insert or update of email on public.profiles
  for each row execute function public.profiles_fill_email();

-- ── 2. Username login without exposing emails ────────────────────────────
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.login_attempts (
  username text primary key,
  failures int not null default 0,
  locked_until timestamptz
);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

-- Returns the account email only if the password is correct; the app then
-- signs in normally with it. 5 wrong tries locks that username for 15 min
-- (email login still works, so this can't lock anyone out entirely).
create or replace function public.email_for_login(p_username text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uname text := lower(trim(leading '@' from trim(p_username)));
  a public.login_attempts;
  v_email text;
  v_hash text;
begin
  select * into a from public.login_attempts where username = uname;
  if a.locked_until is not null and a.locked_until > now() then
    raise exception 'Too many attempts. Try again in 15 minutes or sign in with your email.';
  end if;

  select u.email, u.encrypted_password into v_email, v_hash
  from public.profiles p join auth.users u on u.id = p.id
  where p.username = uname;
  -- Only track real usernames so junk guesses can't grow the table.
  if not found then return null; end if;

  if v_hash is not null and crypt(p_password, v_hash) = v_hash then
    delete from public.login_attempts where username = uname;
    return v_email;
  end if;

  insert into public.login_attempts as la (username, failures) values (uname, 1)
  on conflict (username) do update set
    failures = case when la.locked_until is not null and la.locked_until <= now() then 1 else la.failures + 1 end,
    locked_until = case
      when la.locked_until is not null and la.locked_until <= now() then null
      when la.failures + 1 >= 5 then now() + interval '15 minutes'
    end;
  return null;
end;
$$;

revoke all on function public.email_for_login(text, text) from public;
grant execute on function public.email_for_login(text, text) to anon, authenticated;

-- ── 3. Write rate limits ─────────────────────────────────────────────────
-- Reads can't be limited in the database (they run read-only), but every
-- insert passes through these triggers. Limits are per user per minute and
-- far above normal use, including an offline queue syncing at once.
create table if not exists public.write_rate (
  user_id uuid not null,
  tbl text not null,
  window_start timestamptz not null,
  n int not null,
  primary key (user_id, tbl)
);
alter table public.write_rate enable row level security;
revoke all on public.write_rate from anon, authenticated;

create or replace function public.enforce_write_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  lim int := tg_argv[0]::int;
  cnt int;
begin
  if uid is null then return new; end if;  -- server-side jobs
  insert into public.write_rate as w (user_id, tbl, window_start, n)
  values (uid, tg_table_name, now(), 1)
  on conflict (user_id, tbl) do update set
    n = case when w.window_start < now() - interval '1 minute' then 1 else w.n + 1 end,
    window_start = case when w.window_start < now() - interval '1 minute' then now() else w.window_start end
  returning n into cnt;
  if cnt > lim then
    raise exception 'Too many requests. Slow down and try again in a minute.';
  end if;
  return new;
end;
$$;

drop trigger if exists write_rate on public.workouts;
create trigger write_rate before insert on public.workouts
  for each row execute function public.enforce_write_rate('30');
drop trigger if exists write_rate on public.workout_comments;
create trigger write_rate before insert on public.workout_comments
  for each row execute function public.enforce_write_rate('20');
drop trigger if exists write_rate on public.workout_likes;
create trigger write_rate before insert on public.workout_likes
  for each row execute function public.enforce_write_rate('60');
drop trigger if exists write_rate on public.friendships;
create trigger write_rate before insert on public.friendships
  for each row execute function public.enforce_write_rate('30');
drop trigger if exists write_rate on public.battles;
create trigger write_rate before insert on public.battles
  for each row execute function public.enforce_write_rate('10');
drop trigger if exists write_rate on public.exercise_lists;
create trigger write_rate before insert on public.exercise_lists
  for each row execute function public.enforce_write_rate('60');

-- ── 4. Avatar upload limits ──────────────────────────────────────────────
-- The app uploads a resized JPEG; cap size and type so the bucket can't be
-- used to store arbitrary large files.
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'avatars';
