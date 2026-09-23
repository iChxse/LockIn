-- Battle results on profiles, kept in sync with finished battles:
--   battles_won    - drives the Battle Tested badge and win XP
--   battles_played - finished battles you scored in; losses/draws among these
--                    earn participation XP (played - won)
-- Run after battles.sql. Safe to re-run.
--
-- A battle is won when its frozen final_scores has a single top scorer (a tie
-- at the top is a draw). final_scores only holds players who didn't leave.
-- Battles won by forfeit (one player left standing) count for nothing, so
-- friends can't farm wins or XP by creating and quitting battles. Counts are
-- recomputed rather than incremented so re-finalizing or deleting can't
-- double-count.

alter table public.profiles add column if not exists battles_won int not null default 0;
alter table public.profiles add column if not exists battles_played int not null default 0;

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
    and cardinality(b.participant_ids) - cardinality(b.forfeited_ids) >= 2
    and public.battle_winner(b.final_scores) = p_user;
$$;

-- Every counted win is also a played battle (a sole top score is at least 1).
create or replace function public.count_battles_played(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.battles b
  where b.final_scores is not null
    and b.participant_ids @> array[p_user]
    and cardinality(b.participant_ids) - cardinality(b.forfeited_ids) >= 2
    and coalesce((b.final_scores ->> p_user::text)::numeric, 0) >= 1;
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
     set battles_won = public.count_battles_won(p.id),
         battles_played = public.count_battles_played(p.id)
   where p.id = any(ids);
  return null;
end;
$$;

drop trigger if exists battles_refresh_won on public.battles;
create trigger battles_refresh_won
  after update of final_scores or delete on public.battles
  for each row execute function public.refresh_battles_won();

revoke all on function public.count_battles_won(uuid) from public, anon;
revoke all on function public.count_battles_played(uuid) from public, anon;
revoke all on function public.refresh_battles_won() from public, anon, authenticated;

-- Backfill anyone who already has finished battles.
update public.profiles p
   set battles_won = public.count_battles_won(p.id),
       battles_played = public.count_battles_played(p.id)
 where exists (select 1 from public.battles b where b.participant_ids @> array[p.id]);
