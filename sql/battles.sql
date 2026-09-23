-- Battles: friends compete on scores derived from their logged workouts.
-- Scores are never stored while a battle is running; the app computes them
-- from the workouts table. final_scores is a snapshot written once it ends.
--
-- Lifecycle: pending (waiting on invitees) -> active (clock running) -> ended
-- (active + ends_at passed). A battle whose invitees all decline -> declined.
-- Safe to re-run, including on top of the earlier version of this table.

create table if not exists public.battles (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  metric text not null,
  participant_ids uuid[] not null,
  accepted_ids uuid[] not null default '{}',
  declined_ids uuid[] not null default '{}',
  status text not null default 'pending',
  duration_days int not null,
  starts_at timestamptz,
  ends_at timestamptz,
  final_scores jsonb,
  created_at timestamptz not null default now()
);

alter table public.battles add column if not exists accepted_ids uuid[] not null default '{}';
alter table public.battles add column if not exists declined_ids uuid[] not null default '{}';
alter table public.battles add column if not exists status text not null default 'pending';
alter table public.battles add column if not exists duration_days int;

-- Battles created before invites existed were already running.
update public.battles
   set status = 'active',
       accepted_ids = participant_ids,
       duration_days = greatest(1, round(extract(epoch from (ends_at - starts_at)) / 86400)::int)
 where duration_days is null;

alter table public.battles alter column duration_days set not null;
alter table public.battles alter column starts_at drop default;
alter table public.battles alter column starts_at drop not null;
alter table public.battles alter column ends_at drop not null;
-- A declined 1v1 is left with just its creator, which the old check forbade.
alter table public.battles drop constraint if exists battles_participant_ids_check;

create index if not exists battles_participant_ids_idx on public.battles using gin (participant_ids);

alter table public.battles enable row level security;

drop policy if exists "battles_select_participants" on public.battles;
create policy "battles_select_participants" on public.battles
  for select to authenticated
  using (auth.uid() = any(participant_ids));

-- A new battle is always a pending invite from you to 1-5 accepted friends.
drop policy if exists "battles_insert_with_friends" on public.battles;
create policy "battles_insert_with_friends" on public.battles
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and auth.uid() = any(participant_ids)
    and accepted_ids = array[auth.uid()]
    and declined_ids = '{}'
    and status = 'pending'
    and starts_at is null and ends_at is null and final_scores is null
    and duration_days between 1 and 90
    and cardinality(participant_ids) between 2 and 6
    and cardinality(participant_ids) = (select count(distinct x) from unnest(participant_ids) as x)
    and not exists (
      select 1 from unnest(participant_ids) as p(uid)
      where p.uid <> auth.uid()
        and not exists (
          select 1 from public.friendships f
          where f.status = 'accepted'
            and ((f.requester_id = auth.uid() and f.addressee_id = p.uid)
              or (f.addressee_id = auth.uid() and f.requester_id = p.uid))
        )
    )
  );

-- Participants may write the final snapshot once, after the battle ends.
drop policy if exists "battles_finalize_participants" on public.battles;
create policy "battles_finalize_participants" on public.battles
  for update to authenticated
  using (auth.uid() = any(participant_ids) and status = 'active' and final_scores is null and ends_at <= now())
  with check (auth.uid() = any(participant_ids));

revoke update on public.battles from authenticated;
grant update (final_scores) on public.battles to authenticated;

-- The creator can cancel an invite nobody has finished accepting, or clear a declined one.
drop policy if exists "battles_delete_pending_by_creator" on public.battles;
create policy "battles_delete_pending_by_creator" on public.battles
  for delete to authenticated
  using (created_by = auth.uid() and status in ('pending', 'declined'));

-- Invitees accept or decline through this function so the battle clock can
-- start atomically, on server time, once the last invitee accepts.
create or replace function public.respond_to_battle(p_battle_id uuid, p_accept boolean)
returns public.battles
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.battles;
  me uuid := auth.uid();
begin
  select * into b from public.battles where id = p_battle_id for update;
  if b.id is null or me is null or not (me = any(b.participant_ids)) then
    raise exception 'Battle not found';
  end if;
  if b.status <> 'pending' then
    raise exception 'This battle is no longer waiting for a response';
  end if;
  if me = any(b.accepted_ids) then
    raise exception 'You already accepted this battle';
  end if;

  if p_accept then
    b.accepted_ids := array_append(b.accepted_ids, me);
  else
    b.participant_ids := array_remove(b.participant_ids, me);
    b.declined_ids := array_append(b.declined_ids, me);
  end if;

  if cardinality(b.participant_ids) < 2 then
    b.status := 'declined';
  elsif b.participant_ids <@ b.accepted_ids then
    b.status := 'active';
    b.starts_at := now();
    b.ends_at := now() + make_interval(days => b.duration_days);
  end if;

  update public.battles
     set participant_ids = b.participant_ids,
         accepted_ids = b.accepted_ids,
         declined_ids = b.declined_ids,
         status = b.status,
         starts_at = b.starts_at,
         ends_at = b.ends_at
   where id = b.id
  returning * into b;
  return b;
end;
$$;

revoke all on function public.respond_to_battle(uuid, boolean) from public, anon;
grant execute on function public.respond_to_battle(uuid, boolean) to authenticated;
