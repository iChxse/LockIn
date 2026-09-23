-- Battle Tested badge: profiles.battles_won, kept in sync with finished battles.
-- Run after battles.sql. Safe to re-run.
--
-- A battle is won when its frozen final_scores has a single top scorer (a tie
-- at the top is a draw). Counts are recomputed rather than incremented so
-- re-finalizing or deleting a battle can never double-count.

alter table public.profiles add column if not exists battles_won int not null default 0;

create or replace function public.battle_winner(scores jsonb)
returns uuid
language sql
immutable
as $$
  select case when count(*) filter (where s.score = m.top) = 1
              then (array_agg(s.uid) filter (where s.score = m.top))[1] end
  from (select key::uuid as uid, value::numeric as score from jsonb_each_text(scores)) s,
       (select max(value::numeric) as top from jsonb_each_text(scores)) m;
$$;

create or replace function public.count_battles_won(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.battles b
  where b.final_scores is not null
    and b.participant_ids @> array[p_user]
    and public.battle_winner(b.final_scores) = p_user;
$$;

create or replace function public.refresh_battles_won()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  if tg_op = 'DELETE' then
    ids := old.participant_ids;
  else
    ids := new.participant_ids || old.participant_ids;
  end if;
  update public.profiles p
     set battles_won = public.count_battles_won(p.id)
   where p.id = any(ids);
  return null;
end;
$$;

drop trigger if exists battles_refresh_won on public.battles;
create trigger battles_refresh_won
  after update of final_scores or delete on public.battles
  for each row execute function public.refresh_battles_won();

revoke all on function public.count_battles_won(uuid) from public, anon;
revoke all on function public.refresh_battles_won() from public, anon, authenticated;

-- Backfill anyone who already has finished battles.
update public.profiles p
   set battles_won = public.count_battles_won(p.id)
 where exists (select 1 from public.battles b where b.participant_ids @> array[p.id]);
