-- 0052 (A5 phase 3a — client signed off 2026-07-28): the rollup. agents.* production
-- columns become the SUM across the agent's MLSs (avg columns volume/count-weighted,
-- primary_mls_code = highest-volume MLS), applied ONLY to agents whose per-MLS
-- coverage is COMPLETE (a stats row for every membership) — a partially re-scraped
-- agent keeps its current number, so figures never dip mid-fill. The ingest calls
-- this per batch; each agent flips to the true sum the moment their last MLS reports.
alter table mls add column if not exists stats_agents integer;
alter table enrichment_batches add column if not exists mls_scope uuid[];

create or replace function fn_rollup_agent_stats(p_agent_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare n integer;
begin
  with complete as (
    select am.agent_id
      from agent_mls am
      left join agent_mls_stats s on s.agent_id = am.agent_id and s.mls_id = am.mls_id
     where p_agent_ids is null or am.agent_id = any(p_agent_ids)
     group by am.agent_id
    having bool_and(s.agent_id is not null)
  ),
  agg as (
    select s.agent_id,
           sum(s.sales_volume) as sales_volume,
           sum(s.buy_side_dollar) as buy_side_dollar,
           sum(s.list_side_dollar) as list_side_dollar,
           sum(s.approx_gci) as approx_gci,
           sum(s.closed_transactions) as closed_transactions,
           sum(s.units) as units,
           sum(s.buy_side_count) as buy_side_count,
           sum(s.list_side_count) as list_side_count,
           sum(s.closed_rentals) as closed_rentals,
           case when sum(s.units) > 0 then sum(coalesce(s.avg_sale_price, 0) * coalesce(s.units, 0)) / sum(s.units) end as avg_sale_price,
           case when sum(s.closed_rentals) > 0 then sum(coalesce(s.avg_rental_price, 0) * coalesce(s.closed_rentals, 0)) / sum(s.closed_rentals) end as avg_rental_price,
           case when sum(s.prev_sales_volume) > 0 then (sum(s.sales_volume) - sum(s.prev_sales_volume)) / sum(s.prev_sales_volume) * 100 end as pct_change,
           (array_agg(m.code order by s.sales_volume desc nulls last, m.code))[1] as primary_code
      from agent_mls_stats s
      join mls m on m.id = s.mls_id
     where s.agent_id in (select agent_id from complete)
     group by s.agent_id
  )
  update agents a set
    sales_volume = g.sales_volume, buy_side_dollar = g.buy_side_dollar, list_side_dollar = g.list_side_dollar,
    approx_gci = g.approx_gci, closed_transactions = g.closed_transactions, units = g.units,
    buy_side_count = g.buy_side_count, list_side_count = g.list_side_count, closed_rentals = g.closed_rentals,
    avg_sale_price = g.avg_sale_price, avg_rental_price = g.avg_rental_price, pct_change = g.pct_change,
    primary_mls_code = g.primary_code,
    updated_at = now()
  from agg g
  where a.id = g.agent_id
    and (a.sales_volume is distinct from g.sales_volume
      or a.units is distinct from g.units
      or a.avg_sale_price is distinct from g.avg_sale_price
      or a.primary_mls_code is distinct from g.primary_code);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function fn_rollup_agent_stats(uuid[]) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_refresh_mls_freshness(p_mls_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m record;
begin
  for m in select id from mls where p_mls_ids is null or id = any(p_mls_ids) loop
    update mls set
      stats_agents = (select count(*) from agent_mls_stats where mls_id = m.id),
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
$function$;

revoke all on function fn_refresh_mls_freshness(uuid[]) from public, anon, authenticated;

select fn_refresh_mls_freshness();
