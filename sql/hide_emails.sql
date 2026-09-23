-- Hide profiles.email from every app user (logged in or not). Every other
-- profile column stays publicly readable. Safe to re-run.
--
-- Run only after the app version that selects PROFILE_COLS instead of
-- select('*') is live everywhere (web and the App Store build): older
-- versions ask for every column and will fail to load profiles.
--
-- IMPORTANT: profiles is now readable column-by-column. After adding a
-- column to profiles, re-run this file (it re-grants every column except
-- email) and add the column to PROFILE_COLS in index.html.

revoke select on public.profiles from anon, authenticated;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ') into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles' and column_name <> 'email';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
end $$;
