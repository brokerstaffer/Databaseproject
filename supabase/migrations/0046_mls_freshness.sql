-- 0046 (A8): per-MLS freshness. Two dates matter and differ wildly: the last time ANY
-- agent in the MLS was touched (max — misleading: a stray mixed batch grazes every MLS)
-- and the date the BULK of the MLS was actually refreshed (most recent day covering
-- >= 25% of members; else the biggest day). Both are materialized on mls, stamped by
-- the ingest after every batch, and backfilled retroactively here from
-- agent_source_stats.scraped_at (100% populated). agent_mls_stats.scraped_at takes
-- over as the per-(agent,MLS) source as it fills.
alter table mls
  add column if not exists last_touched_at timestamptz,
  add column if not exists bulk_refreshed_at timestamptz,
  add column if not exists bulk_agents integer,
  add column if not exists member_agents integer;

create or replace function fn_refresh_mls_freshness(p_mls_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  m record;
begin
  for m in select id from mls where p_mls_ids is null or id = any(p_mls_ids) loop
    update mls set
      member_agents = s.members,
      last_touched_at = s.mx,
      bulk_refreshed_at = s.bulk_day,
      bulk_agents = s.bulk_n
    from (
      with touched as (
        select am.agent_id, coalesce(ams.scraped_at, ass.scraped_at) as ts
          from agent_mls am
          left join agent_mls_stats ams on ams.agent_id = am.agent_id and ams.mls_id = am.mls_id
          left join agent_source_stats ass on ass.agent_id = am.agent_id and ass.source = 'courted'
         where am.mls_id = m.id
      ), days as (
        select date_trunc('day', ts) as d, count(*) as n from touched where ts is not null group by 1
      ), pick as (
        select coalesce(
                 (select max(d) from days where n >= greatest(1, (select count(*) from touched) / 4)),
                 (select d from days order by n desc, d desc limit 1)) as bulk_day
      )
      select (select count(*) from touched) as members,
             (select max(ts) from touched) as mx,
             (select bulk_day from pick) as bulk_day,
             coalesce((select n from days, pick where days.d = pick.bulk_day), 0) as bulk_n
    ) s
    where mls.id = m.id;
  end loop;
end;
$$;
revoke all on function fn_refresh_mls_freshness(uuid[]) from public, anon, authenticated;

select fn_refresh_mls_freshness();
