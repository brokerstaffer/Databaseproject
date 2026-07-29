-- 0061: Location tab basis selector — office / home / most-transacted / all combined
-- (combined dedups to one row per place+agent, so no double counting).

CREATE OR REPLACE FUNCTION public.fn_filter_search(p_mode text DEFAULT 'agent'::text, p_source text DEFAULT 'courted'::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort_by text DEFAULT 'sales_volume'::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '128MB'
AS $function$
declare v_where text; v_order text; v_sort_col text; v_dir text; v_count bigint; v_volume numeric; v_data jsonb; v_minoff int;
  v_gran text; v_lbl text; v_grp text; v_nn text; v_kind text; v_ccol text; v_kcol text; v_stcol text; v_ctycol text;
  sel_mls uuid[]; scoped boolean := false; v_sc text; v_scord text;
begin
  if p_mode = 'location' then
    -- D4 + Stephanie's follow-up: location grain over a chosen BASIS — the agent's office,
    -- home, or most-transacted location, or ALL three combined (an agent counts once per
    -- place even when several of their locations land in the same place).
    v_where := fn_agent_where(p_source, p_filters);
    v_gran := case p_filters->>'locGranularity' when 'county' then 'county' when 'city' then 'city' else 'state' end;
    v_kind := case p_filters->>'locKind' when 'home' then 'home' when 'transacted' then 'transacted' when 'all' then 'all' else 'office' end;
    v_sort_col := case p_sort_by when 'location' then 'location' when 'agents' then 'agents' when 'offices' then 'offices' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    if v_kind <> 'all' then
      if v_kind = 'office' then v_ccol := 'office_city'; v_kcol := 'office_city_key'; v_stcol := 'office_state'; v_ctycol := 'office_county';
      elsif v_kind = 'home' then v_ccol := 'home_city'; v_kcol := 'home_city_key'; v_stcol := 'home_state'; v_ctycol := 'home_county';
      else v_ccol := 'most_transacted_city'; v_kcol := 'most_transacted_city_key'; v_stcol := 'transacted_state'; v_ctycol := 'most_transacted_county';
      end if;
      if v_gran = 'state' then
        v_lbl := format('upper(a.%I)', v_stcol); v_grp := format('upper(a.%I)', v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L', v_stcol, v_stcol, '');
      elsif v_gran = 'county' then
        v_lbl := format('initcap(min(a.%I)) || %L || upper(a.%I)', v_ctycol, ', ', v_stcol);
        v_grp := format('lower(a.%I), upper(a.%I)', v_ctycol, v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L and a.%I is not null', v_ctycol, v_ctycol, '', v_stcol);
      else
        v_lbl := format('min(a.%I) || %L || upper(a.%I)', v_ccol, ', ', v_stcol);
        v_grp := format('a.%I, upper(a.%I)', v_kcol, v_stcol);
        v_nn := format('a.%I is not null and a.%I is not null', v_kcol, v_stcol);
      end if;
      execute format($q$
        with g as (
          select %s as location, count(*)::bigint as agents, count(distinct a.office_id)::bigint as offices,
                 coalesce(sum(a.sales_volume), 0)::numeric as sales_volume, coalesce(sum(a.units), 0)::numeric as units
            from agents a
           where (%s) and %s
           group by %s
        )
        select (select count(*) from g),
               (select coalesce(sum(sales_volume), 0) from g),
               coalesce((select jsonb_agg(to_jsonb(t)) from (
                  select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
      $q$, v_lbl, v_where, v_nn, v_grp, v_sort_col, v_dir, p_limit, p_offset)
      into v_count, v_volume, v_data;
      return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
    end if;

    -- ALL basis: expand each agent to (office, home, transacted) tuples, dedup to one row
    -- per (place, agent), then aggregate — a place's numbers never double-count an agent.
    if v_gran = 'state' then
      v_grp := 'v.st'; v_lbl := 'p.gkey'; v_nn := 'v.st is not null'; v_ccol := 'min(v.rawc)';
    elsif v_gran = 'county' then
      v_grp := 'lower(v.cty)'; v_lbl := $c$initcap(n.disp) || ', ' || p.gst$c$;
      v_nn := $c$v.cty is not null and btrim(v.cty) <> '' and v.st is not null$c$;
      v_ccol := 'min(v.cty)'; -- display = the county's raw spelling
    else
      v_grp := 'v.ck'; v_lbl := $c$n.disp || ', ' || p.gst$c$;
      v_nn := 'v.ck is not null and v.st is not null';
      v_ccol := 'min(v.rawc)'; -- display = the city's raw spelling
    end if;
    execute format($q$
      with lat as (
        select a.id, a.office_id, a.sales_volume, a.units, v.ck, v.rawc, v.st, v.cty
          from agents a
          cross join lateral (values
            (a.office_city_key, a.office_city, upper(a.office_state), a.office_county),
            (a.home_city_key, a.home_city, upper(a.home_state), a.home_county),
            (a.most_transacted_city_key, a.most_transacted_city, upper(a.transacted_state), a.most_transacted_county)
          ) v(ck, rawc, st, cty)
         where (%s) and %s
      ),
      pairs as (
        select distinct %s as gkey, v.st as gst, id, office_id, sales_volume, units from lat v
      ),
      names as (
        select %s as gkey, v.st as gst, %s as disp from lat v group by 1, 2
      ),
      g as (
        select %s as location, count(*)::bigint as agents, count(distinct p.office_id)::bigint as offices,
               coalesce(sum(p.sales_volume), 0)::numeric as sales_volume, coalesce(sum(p.units), 0)::numeric as units
          from pairs p left join names n on n.gkey = p.gkey and n.gst is not distinct from p.gst
         group by p.gkey, p.gst, n.disp
      )
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_nn, v_grp, v_grp, v_ccol, v_lbl, v_sort_col, v_dir, p_limit, p_offset)
    into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'brand' then
    -- B5: brand grain = GROUP BY brand over the (filtered) offices table. Office-level
    -- filters apply per office BEFORE aggregation. Single-office "brands" are just the
    -- brokerage's own name (91k of 97k), so they are hidden unless the caller passes
    -- includeSingleOfficeBrands=true.
    v_where := fn_office_where(p_filters);
    v_sort_col := case p_sort_by when 'brand' then 'brand' when 'office_count' then 'office_count' when 'agent_count' then 'agent_count' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    v_minoff := case when coalesce(p_filters->>'includeSingleOfficeBrands', '') = 'true' then 1 else 2 end;
    execute format($q$
      with g as (
        select brand, count(*)::int as office_count, coalesce(sum(agent_count), 0)::bigint as agent_count,
               coalesce(sum(sales_volume), 0)::numeric as sales_volume, coalesce(sum(units), 0)::numeric as units
          from offices
         where (%s) and brand is not null and btrim(brand) <> ''
         group by brand
        having count(*) >= %s
      )
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, brand asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_minoff, v_sort_col, v_dir, p_limit, p_offset) into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

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

  -- A5 phase 3: when every selected MLS has near-complete stats coverage, the table
  -- shows (and sorts by) THAT MLS's numbers — same gate as fn_agent_where's filters.
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) > 0 then
    sel_mls := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
    select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
      into scoped from mls where id = any(sel_mls);
    scoped := coalesce(scoped, false);
  end if;

  if scoped then
    v_sc := format($sc$(select agent_id,
        sum(sales_volume) as sales_volume, sum(buy_side_dollar) as buy_side_dollar,
        sum(list_side_dollar) as list_side_dollar, sum(approx_gci) as approx_gci,
        sum(closed_transactions) as closed_transactions, sum(units) as units,
        sum(buy_side_count) as buy_side_count, sum(list_side_count) as list_side_count,
        sum(closed_rentals) as closed_rentals,
        case when sum(units) > 0 then sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / sum(units) end as avg_sale_price,
        case when sum(closed_rentals) > 0 then sum(coalesce(avg_rental_price, 0) * coalesce(closed_rentals, 0)) / sum(closed_rentals) end as avg_rental_price,
        case when sum(prev_sales_volume) > 0 then (sum(sales_volume) - sum(prev_sales_volume)) / sum(prev_sales_volume) * 100 end as pct_change
      from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id)$sc$, sel_mls);
    -- scoped sort for production columns; everything else keeps the normal order
    v_scord := case coalesce(p_sort_by, 'sales_volume')
      when 'sales_volume' then 'sales_volume' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
      when 'closed_transactions' then 'closed_transactions' when 'approx_gci' then 'approx_gci'
      when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
      when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
      when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
      when 'pct_change' then 'pct_change' else null end;
    if v_scord is not null then
      v_order := format('sc.%I %s nulls last', v_scord, case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end);
    end if;
    execute format('select count(*), coalesce(sum(sc.sales_volume), 0) from agents a left join %s sc on sc.agent_id = a.id where %s', v_sc, v_where)
      into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select to_jsonb(a)
            || case when sc.agent_id is null
                 then jsonb_build_object('sales_volume', null, 'buy_side_dollar', null, 'list_side_dollar', null,
                        'approx_gci', null, 'closed_transactions', null, 'units', null, 'buy_side_count', null,
                        'list_side_count', null, 'closed_rentals', null, 'avg_sale_price', null,
                        'avg_rental_price', null, 'pct_change', null)
                 else to_jsonb(sc) - 'agent_id' end
            || jsonb_build_object('mls_scoped', true,
                 'mls', (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
                           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id),
                 'source_stats', (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
                                    from agent_source_stats s where s.agent_id = a.id),
                 'client_campaigns', (select string_agg(distinct c.client_name, ', ' order by c.client_name)
                                        from bison_client_leads b join orch_clients c on c.id = b.client_id
                                       where b.agent_id = a.id),
                 'has_replied', exists(select 1 from bison_client_leads b3 where b3.agent_id = a.id and b3.replied)) as t
        from agents a left join %s sc on sc.agent_id = a.id where %s order by %s, a.id limit %s offset %s
      ) t $q$, v_sc, v_where, v_order, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;
  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
        (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
           from agent_source_stats s where s.agent_id = a.id) as source_stats,
        (select string_agg(distinct c.client_name, ', ' order by c.client_name)
           from bison_client_leads b join orch_clients c on c.id = b.client_id
          where b.agent_id = a.id) as client_campaigns,
        exists(select 1 from bison_client_leads b3 where b3.agent_id = a.id and b3.replied) as has_replied
      from agents a where %s order by %s limit %s offset %s
    ) t $q$, v_where, v_order, p_limit, p_offset) into v_data;
  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$function$;

grant execute on function fn_filter_search(text, text, jsonb, text, text, int, int) to anon, authenticated;
