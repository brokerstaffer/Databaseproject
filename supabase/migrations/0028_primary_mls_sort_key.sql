-- 0028_primary_mls_sort_key.sql
-- Fix: sorting by MLS affiliation timed out (~23s at 755k agents) because fn_agent_order sorted
-- on fn_agent_primary_mls(id) — a per-row subquery evaluated across the whole table on every
-- sort. Materialize that value into an indexed column so the MLS sort is a plain column sort
-- (~1s, same class as the LinkedIn sort). App-transparent: fn_filter_search/fn_filter_ids just
-- call fn_agent_order, which now maps 'mls' -> the column. No app redeploy required.
-- Idempotent.

set statement_timeout = 600000;  -- 10min headroom for the one-time backfill

-- 1) Materialized sort key: the agent's alphabetically-first MLS code (null = unaffiliated).
alter table agents add column if not exists primary_mls_code text;

-- 2) One-time backfill (set-based: aggregate agent_mls once, then join-update).
update agents a
   set primary_mls_code = sub.code
  from (select am.agent_id, min(m.code) as code
          from agent_mls am join mls m on m.id = am.mls_id
         group by am.agent_id) sub
 where sub.agent_id = a.id
   and a.primary_mls_code is distinct from sub.code;

-- 3) Index for the sort (asc nulls last matches the default btree ordering).
create index if not exists idx_agents_primary_mls on agents(primary_mls_code);

-- 4) Keep it current whenever an agent's MLS set changes (ingest writes agent_mls).
create or replace function fn_sync_primary_mls() returns trigger
language plpgsql set search_path = public as $$
declare aid uuid;
begin
  aid := coalesce(new.agent_id, old.agent_id);
  update agents
     set primary_mls_code = (select min(m.code) from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = aid)
   where id = aid;
  return null;
end $$;

drop trigger if exists trg_sync_primary_mls on agent_mls;
create trigger trg_sync_primary_mls after insert or update or delete on agent_mls
  for each row execute function fn_sync_primary_mls();

-- 5) Point the MLS sort at the materialized column (drops the per-row function from ORDER BY).
create or replace function fn_agent_order(p_filters jsonb, p_sort_by text, p_sort_dir text) returns text
language sql immutable as $$
  select case when coalesce(p_filters->>'nameQuery', '') <> ''
    then format('(full_name ilike %L) desc, ', '%' || (p_filters->>'nameQuery') || '%') else '' end
  || format('%I %s nulls last',
       case p_sort_by
         when 'full_name' then 'full_name' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
         when 'closed_transactions' then 'closed_transactions' when 'est_time_in_industry_months' then 'est_time_in_industry_months'
         when 'license_number' then 'license_number' when 'office_name' then 'office_name'
         when 'est_time_at_office_months' then 'est_time_at_office_months' when 'avg_time_at_office_months' then 'avg_time_at_office_months'
         when 'approx_gci' then 'approx_gci' when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
         when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
         when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
         when 'pct_change' then 'pct_change' when 'home_city' then 'home_city' when 'home_zip' then 'home_zip'
         when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' when 'brand' then 'brand'
         when 'most_transacted_city' then 'most_transacted_city'
         when 'preferred_email' then 'preferred_email' when 'preferred_phone' then 'preferred_phone'
         when 'total_sales_all_time' then 'total_sales_all_time' when 'avg_price_all_time' then 'avg_price_all_time'
         when 'avg_sales_volume_all_time' then 'avg_sales_volume_all_time'
         when 'linkedin_url' then 'linkedin_url'
         when 'mls' then 'primary_mls_code'
         else 'sales_volume' end,
       case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
$$;
grant execute on function fn_agent_order(jsonb, text, text) to anon, authenticated;
