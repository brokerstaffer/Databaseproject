-- 0047 (B1): every rendered Office-view column becomes sortable. The office sort
-- whitelist gains brand / office_city / office_zip (unknown keys still fall back to
-- sales_volume). Measured on the live 120,670-row offices table: worst new sort is a
-- 46-212ms cached top-N heapsort — no new indexes needed.

CREATE OR REPLACE FUNCTION public.fn_filter_search(p_mode text DEFAULT 'agent'::text, p_source text DEFAULT 'courted'::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort_by text DEFAULT 'sales_volume'::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '128MB'
AS $function$
declare v_where text; v_order text; v_sort_col text; v_dir text; v_count bigint; v_volume numeric; v_data jsonb;
begin
  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
    v_sort_col := case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count' when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' when 'brand' then 'brand' when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' else 'sales_volume' end;
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
  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;
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
