-- 0029_review_fixes.sql
-- Fixes from the adversarial review of the multi-client/multi-campaign commit (af8ccbb):
--   (1) MLS display order: fn_filter_search built the per-agent mls array with an unordered
--       jsonb_agg, so a grid sorted by MLS (which sorts on primary_mls_code = the
--       alphabetically-FIRST code) showed e.g. "GAMLS | ABOR" amid the ABOR rows — ~13% of
--       agents are multi-MLS, so the sorted column looked broken. Aggregate ORDER BY m.code
--       so the displayed first code always equals the sort key.
--   (2) fn_sync_primary_mls: add an IS DISTINCT FROM guard so the weekly re-ingest's
--       ON CONFLICT DO UPDATE storm on agent_mls doesn't rewrite ~755k unchanged agents rows
--       (WAL + index bloat for zero data change).
--   (3) enrichment_items.target_campaign_ids: the push stage's per-client dedup decision is
--       computed once against PRE-batch campaign memberships and persisted here, so a retry
--       neither re-evaluates against the batch's own partial attaches nor duplicates the
--       client_dedup step notes; refreshActiveBatches uses it to flag leads_imported_campaign
--       only on campaigns that actually received a sent lead.
-- Idempotent.

-- (1) ordered mls array — displayed first code = sort key (min code)
create or replace function fn_filter_search(
  p_mode text default 'agent', p_source text default 'courted', p_filters jsonb default '{}',
  p_sort_by text default 'sales_volume', p_sort_dir text default 'desc',
  p_limit int default 50, p_offset int default 0
) returns jsonb
language plpgsql stable security definer set search_path = public as $function$
declare v_where text; v_order text; v_sort_col text; v_dir text; v_count bigint; v_volume numeric; v_data jsonb;
begin
  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
    v_sort_col := case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count' when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    execute format('select count(*), coalesce(sum(sales_volume), 0) from offices where %s', v_where) into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t.j), '[]'::jsonb) from (
        select to_jsonb(o) || jsonb_build_object(
                 'agent_names', (select coalesce(jsonb_agg(ag.full_name order by ag.sv desc nulls last), '[]'::jsonb)
                                  from (select full_name, sales_volume sv from agents where office_id = o.id order by sales_volume desc nulls last limit 25) ag)
               ) as j
        from offices o where %s order by o.%I %s nulls last limit %s offset %s
      ) t $q$, v_where, v_sort_col, v_dir, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  v_where := fn_agent_where(p_source, p_filters);
  v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);
  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents where %s', v_where) into v_count, v_volume;
  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
        (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
           from agent_source_stats s where s.agent_id = a.id) as source_stats
      from agents a where %s order by %s limit %s offset %s
    ) t $q$, v_where, v_order, p_limit, p_offset) into v_data;
  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$function$;
grant execute on function fn_filter_search(text, text, jsonb, text, text, int, int) to anon, authenticated;

-- (2) no-op-guarded sync trigger (same trigger wiring; only the function body changes)
create or replace function fn_sync_primary_mls() returns trigger
language plpgsql set search_path = public as $$
declare aid uuid; v text;
begin
  aid := coalesce(new.agent_id, old.agent_id);
  v := (select min(m.code) from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = aid);
  update agents set primary_mls_code = v
   where id = aid and primary_mls_code is distinct from v;
  return null;
end $$;

-- (3) persisted per-item dedup decision for multi-campaign pushes
alter table enrichment_items add column if not exists target_campaign_ids text[];
