-- 0004_fn_filter_search.sql
-- Agent/Office search RPC. Returns { data, totalCount, salesVolumeTotal }.
-- M3: pagination + sort + per-result totals (the "$X Sales volume" header).
-- Filter WHERE-building (location, sales volume, brand/office, mls, license) is layered
-- on in M4/M5; p_filters is accepted now so the contract is stable. SECURITY DEFINER so
-- it runs regardless of RLS; granted to anon + authenticated.

create or replace function fn_filter_search(
  p_mode    text  default 'agent',
  p_source  text  default 'courted',
  p_filters jsonb default '{}'::jsonb,
  p_sort_by text  default 'sales_volume',
  p_sort_dir text default 'desc',
  p_limit   int   default 50,
  p_offset  int   default 0
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sort_col text;
  v_dir text;
  v_count bigint;
  v_volume numeric;
  v_data jsonb;
begin
  v_sort_col := case p_sort_by
    when 'full_name' then 'full_name'
    when 'units' then 'units'
    when 'avg_sale_price' then 'avg_sale_price'
    when 'closed_transactions' then 'closed_transactions'
    when 'est_time_in_industry_months' then 'est_time_in_industry_months'
    else 'sales_volume'
  end;
  v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

  select count(*), coalesce(sum(sales_volume), 0) into v_count, v_volume from agents;

  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb)
    from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id))
           from agent_mls am join mls m on m.id = am.mls_id
          where am.agent_id = a.id) as mls
      from agents a
      order by %I %s nulls last
      limit %s offset %s
    ) t
  $q$, v_sort_col, v_dir, p_limit, p_offset) into v_data;

  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$$;

grant execute on function fn_filter_search(text, text, jsonb, text, text, int, int) to anon, authenticated;
