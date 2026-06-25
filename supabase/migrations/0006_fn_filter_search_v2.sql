-- 0006_fn_filter_search_v2.sql
-- Full WHERE-building for the Agent Search filters. SECURITY DEFINER; granted anon+authenticated.

-- Single bucket label -> SQL fragment (covers $ ranges, counts, year ranges [col in months], GCI).
create or replace function fn_bucket_cond(p_col text, p_label text) returns text language sql immutable as $$
  select case p_label
    when '$0-5M'    then format('%1$I >= 0 and %1$I < 5000000', p_col)
    when '$5-10M'   then format('%1$I >= 5000000 and %1$I < 10000000', p_col)
    when '$10-20M'  then format('%1$I >= 10000000 and %1$I < 20000000', p_col)
    when '$20-50M'  then format('%1$I >= 20000000 and %1$I < 50000000', p_col)
    when '$50-100M' then format('%1$I >= 50000000 and %1$I < 100000000', p_col)
    when '$100M+'   then format('%1$I >= 100000000', p_col)
    when '1-5'   then format('%1$I >= 1 and %1$I <= 5', p_col)
    when '5-10'  then format('%1$I > 5 and %1$I <= 10', p_col)
    when '10-20' then format('%1$I > 10 and %1$I <= 20', p_col)
    when '20+'   then format('%1$I > 20', p_col)
    when '0-1yr'   then format('%1$I >= 0 and %1$I < 12', p_col)
    when '1-3yrs'  then format('%1$I >= 12 and %1$I < 36', p_col)
    when '3-5yrs'  then format('%1$I >= 36 and %1$I < 60', p_col)
    when '5-10yrs' then format('%1$I >= 60 and %1$I < 120', p_col)
    when '10+yrs'  then format('%1$I >= 120', p_col)
    when '$0-100K'    then format('%1$I >= 0 and %1$I < 100000', p_col)
    when '$100-250K'  then format('%1$I >= 100000 and %1$I < 250000', p_col)
    when '$250-500K'  then format('%1$I >= 250000 and %1$I < 500000', p_col)
    when '$500K-1M'   then format('%1$I >= 500000 and %1$I < 1000000', p_col)
    when '$1M+'       then format('%1$I >= 1000000', p_col)
    else 'true'
  end;
$$;

-- Range filter -> condition for { buckets[], min, max } applied to p_col. Returns null if empty.
create or replace function fn_range_cond(p_col text, f jsonb) returns text language plpgsql immutable as $$
declare bconds text[] := '{}'; conds text[] := '{}'; b text; vmin numeric; vmax numeric;
begin
  if f is null then return null; end if;
  if jsonb_array_length(coalesce(f->'buckets', '[]'::jsonb)) > 0 then
    for b in select jsonb_array_elements_text(f->'buckets') loop
      bconds := bconds || fn_bucket_cond(p_col, b);
    end loop;
    if array_length(bconds, 1) > 0 then conds := conds || ('(' || array_to_string(bconds, ' or ') || ')'); end if;
  end if;
  vmin := nullif(f->>'min', '')::numeric;
  vmax := nullif(f->>'max', '')::numeric;
  if vmin is not null then conds := conds || format('%I >= %s', p_col, vmin); end if;
  if vmax is not null then conds := conds || format('%I <= %s', p_col, vmax); end if;
  if array_length(conds, 1) > 0 then return '(' || array_to_string(conds, ' and ') || ')'; end if;
  return null;
end;
$$;

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
  parts text[] := '{}';
  v_where text := 'true';
  v_sort_col text; v_dir text;
  v_count bigint; v_volume numeric; v_data jsonb;
  f jsonb; sub jsonb;
  arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; side text; c text;
begin
  -- =========================================================
  -- OFFICE MODE: query the offices table (office-level filters), return offices + their agents.
  -- =========================================================
  if p_mode = 'office' then
    f := p_filters->'location';
    if f is not null and jsonb_array_length(coalesce(f->'values', '[]'::jsonb)) > 0 then
      field := coalesce(f->>'field', 'city');
      arr := array(select jsonb_array_elements_text(f->'values'));
      col := case field when 'state' then 'office_state' else 'office_' || field end;
      parts := parts || format('%I = ANY(%L::text[])', col, arr);
    end if;

    f := p_filters->'salesVolume';
    if f is not null then
      side := coalesce(f->>'side', 'all');
      col := case side when 'list' then 'list_side_dollar' when 'buy' then 'buy_side_dollar' else 'sales_volume' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;

    f := p_filters->'officeSearch';
    if f is not null then
      sub := f->'brand';
      if sub is not null then
        if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
          parts := parts || format('brand = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
        end if;
        if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
          parts := parts || format('(brand is null or brand <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
        end if;
      end if;
      sub := f->'office';
      if sub is not null then
        if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
          parts := parts || format('office_name = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
        end if;
        if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
          parts := parts || format('(office_name is null or office_name <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
        end if;
      end if;
    end if;

    f := p_filters->'closedUnits';
    if f is not null then c := fn_range_cond('units', f); if c is not null then parts := parts || c; end if; end if;

    if array_length(parts, 1) > 0 then v_where := array_to_string(parts, ' and '); end if;

    v_sort_col := case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    execute format('select count(*), coalesce(sum(sales_volume), 0) from offices where %s', v_where) into v_count, v_volume;

    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb)
      from (
        select o.*,
          (select coalesce(jsonb_agg(ag.full_name order by ag.sv desc nulls last), '[]'::jsonb)
             from (select full_name, sales_volume sv from agents where office_id = o.id order by sales_volume desc nulls last limit 25) ag) as agent_names
        from offices o
        where %s
        order by %I %s nulls last
        limit %s offset %s
      ) t
    $q$, v_where, v_sort_col, v_dir, p_limit, p_offset) into v_data;

    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  -- DATA SOURCE: 'all' = no filter; 'courted' = stored Courted data; 'zillow_realtor' = on-demand.
  if p_source = 'zillow_realtor' then
    parts := parts || format('sources && %L::text[]', array['zillow', 'realtor']);
  elsif p_source = 'courted' then
    parts := parts || format('sources && %L::text[]', array['courted']);
  end if;

  -- LOCATION: chosen field across selected location kinds (OR), no include/exclude.
  f := p_filters->'location';
  if f is not null and jsonb_array_length(coalesce(f->'values', '[]'::jsonb)) > 0 then
    field := coalesce(f->>'field', 'city');
    arr := array(select jsonb_array_elements_text(f->'values'));
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    kconds := '{}';
    foreach kind in array kinds loop
      col := case kind
        when 'office' then 'office_' || field
        when 'home' then 'home_' || field
        when 'transacted' then case field
          when 'city' then 'most_transacted_city'
          when 'zip' then 'most_transacted_zip'
          when 'county' then 'most_transacted_county'
          when 'state' then 'transacted_state' else null end
        else null end;
      if col is not null then kconds := kconds || format('%I = ANY(%L::text[])', col, arr); end if;
    end loop;
    if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
  end if;

  -- RANGE-with-side filters
  f := p_filters->'salesVolume';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    col := case side when 'list' then 'list_side_dollar' when 'buy' then 'buy_side_dollar' else 'sales_volume' end;
    c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'closedUnits';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'units' end;
    c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'closedTransactions';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'closed_transactions' end;
    c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
  end if;

  -- RANGE filters (no side)
  f := p_filters->'estTimeInIndustry';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_in_industry_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'approxGci';
  if f is not null then
    c := fn_range_cond('approx_gci', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'avgSalePrice';
  if f is not null then
    c := fn_range_cond('avg_sale_price', f); if c is not null then parts := parts || c; end if;
  end if;

  -- time-at-office filters: min/max entered in YEARS -> months (buckets already in months).
  f := p_filters->'estTimeInOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'avgTimeAtOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('avg_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  -- OFFICE SEARCH: brand + office, independent include/exclude (grouped, simultaneous).
  f := p_filters->'officeSearch';
  if f is not null then
    sub := f->'brand';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('brand = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(brand is null or brand <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
    sub := f->'office';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('office_name = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(office_name is null or office_name <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
  end if;

  -- MLS (via junction)
  f := p_filters->'mls';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('id in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('id not in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  -- TITLE (role)
  f := p_filters->'title';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('title = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(title is null or title <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  -- LICENSE (license number)
  f := p_filters->'license';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('license_number = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(license_number is null or license_number <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  if array_length(parts, 1) > 0 then
    v_where := array_to_string(parts, ' and ');
  end if;

  v_sort_col := case p_sort_by
    when 'full_name' then 'full_name'
    when 'units' then 'units'
    when 'avg_sale_price' then 'avg_sale_price'
    when 'closed_transactions' then 'closed_transactions'
    when 'est_time_in_industry_months' then 'est_time_in_industry_months'
    else 'sales_volume'
  end;
  v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents where %s', v_where) into v_count, v_volume;

  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb)
    from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id))
           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
        (select jsonb_agg(jsonb_build_object('source', s.source, 'sales_volume', s.sales_volume, 'units', s.units) order by s.source)
           from agent_source_stats s where s.agent_id = a.id) as source_stats
      from agents a
      where %s
      order by %I %s nulls last
      limit %s offset %s
    ) t
  $q$, v_where, v_sort_col, v_dir, p_limit, p_offset) into v_data;

  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$$;

grant execute on function fn_filter_search(text, text, jsonb, text, text, int, int) to anon, authenticated;
