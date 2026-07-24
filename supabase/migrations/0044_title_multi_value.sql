-- 0044: title filter understands multi-title values.
-- The scraper will send agents with multiple roles as one title string separated by
-- comma (or slash), e.g. 'Salesperson, Managing Broker'. Exact equality would miss
-- these, so the filter now splits the column on commas and matches per token,
-- normalized (lowercase, punctuation/spacing stripped) on both sides. Exclude keeps
-- null-title agents. fn_search_options 'title' returns the distinct tokens actually
-- present (so new titles become filterable without a code change).

CREATE OR REPLACE FUNCTION public.fn_agent_where(p_source text, p_filters jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; vconds text[]; side text; c text; v text; vst text; vbase text;
  citycol text; statecol text; ccol text;
  v_client_ids text[];
  view_id text; vv jsonb; vmode text; vsrc text; vwhere text;
begin
  if p_source = 'zillow_realtor' then
    parts := parts || format('sources && %L::text[]', array['zillow', 'realtor']);
  elsif p_source = 'courted' then
    parts := parts || format('sources && %L::text[]', array['courted']);
  end if;

  v_client_ids := case
    when jsonb_typeof(p_filters->'orchClientIds') = 'array' and jsonb_array_length(p_filters->'orchClientIds') > 0
      then array(select jsonb_array_elements_text(p_filters->'orchClientIds'))
    when coalesce(p_filters->>'orchClientId', '') <> ''
      then array[p_filters->>'orchClientId']
    else null end;
  if v_client_ids is not null then
    if coalesce(p_filters->>'orchClientMode', 'include') = 'exclude' then
      parts := parts || format('id not in (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id))', v_client_ids);
    else
      parts := parts || format('id in (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id))', v_client_ids);
    end if;
  end if;

  -- LOCATION (A14: values = include, excludeValues = exclude). Exclude wraps in
  -- not coalesce(cond, false) so agents with NULL location columns are KEPT — "not in Miami"
  -- must not drop agents whose location is simply unknown.
  f := p_filters->'location';
  if f is not null then
    field := coalesce(f->>'field', 'city');
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    foreach side in array array['values', 'excludeValues'] loop
      if jsonb_typeof(f->side) = 'array' and jsonb_array_length(f->side) > 0 then
        kconds := '{}';
        foreach kind in array kinds loop
          citycol := case kind when 'office' then 'office_city' when 'home' then 'home_city' when 'transacted' then 'most_transacted_city' else null end;
          statecol := case kind when 'office' then 'office_state' when 'home' then 'home_state' when 'transacted' then 'transacted_state' else null end;
          ccol := case kind when 'office' then 'office_county' when 'home' then 'home_county' when 'transacted' then 'most_transacted_county' else null end;
          if citycol is null then continue; end if;

          if field = 'city' or field = 'county' then
            -- keys are computed HERE (once) and matched via = ANY(array): one match-key
            -- evaluation per row per kind, index-friendly. The old per-value OR chain
            -- evaluated the regex key per VALUE per row — a 40-city saved view was ~93M
            -- regex calls and blew the API statement timeout (rendered as "0 agents").
            vconds := '{}';
            arr := array(select distinct case when field = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end
                         from jsonb_array_elements_text(f->side) x(v)
                         where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is null
                           and (case when field = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end) is not null);
            if array_length(arr, 1) > 0 then
              if field = 'city' then
                vconds := vconds || format('fn_city_match_key(%I) = ANY(%L::text[])', citycol, arr);
              else
                vconds := vconds || format('lower(%I) = ANY(%L::text[])', ccol, arr);
              end if;
            end if;
            for vst in select distinct upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1])
                       from jsonb_array_elements_text(f->side) x(v)
                       where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is not null loop
              arr := array(select distinct case when field = 'city' then fn_city_match_key(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) else lower(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) end
                           from jsonb_array_elements_text(f->side) x(v)
                           where upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1]) = vst);
              arr := array(select y from unnest(arr) y where y is not null);
              if array_length(arr, 1) > 0 then
                if field = 'city' then
                  vconds := vconds || format('(fn_city_match_key(%I) = ANY(%L::text[]) and coalesce(upper(%I), fn_city_embedded_state(%I)) = %L)', citycol, arr, statecol, citycol, vst);
                else
                  vconds := vconds || format('(lower(%I) = ANY(%L::text[]) and upper(%I) = %L)', ccol, arr, statecol, vst);
                end if;
              end if;
            end loop;
            if array_length(vconds, 1) > 0 then kconds := kconds || ('(' || array_to_string(vconds, ' or ') || ')'); end if;
          else
            arr := array(select jsonb_array_elements_text(f->side));
            col := case field
              when 'zip' then case kind when 'office' then 'office_zip' when 'home' then 'home_zip' else 'most_transacted_zip' end
              when 'state' then statecol
              else null end;
            if field = 'state' and col is not null then
              kconds := kconds || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
            elsif col is not null then
              kconds := kconds || format('%I = ANY(%L::text[])', col, arr);
            end if;
          end if;
        end loop;
        if array_length(kconds, 1) > 0 then
          if side = 'excludeValues' then
            parts := parts || ('not coalesce((' || array_to_string(kconds, ' or ') || '), false)');
          else
            parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
          end if;
        end if;
      end if;
    end loop;
  end if;

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

  f := p_filters->'estTimeInIndustry';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_in_industry_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'approxGci';
  if f is not null then c := fn_range_cond('approx_gci', f); if c is not null then parts := parts || c; end if; end if;

  f := p_filters->'avgSalePrice';
  if f is not null then c := fn_range_cond('avg_sale_price', f); if c is not null then parts := parts || c; end if; end if;

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

  f := p_filters->'mls';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('id in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('id not in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  -- A5: agents affiliated with 2+ MLSs
  if coalesce(p_filters->>'multiMls', '') = 'true' then
    parts := parts || 'id in (select agent_id from agent_mls group by agent_id having count(*) > 1)'::text;
  end if;

  -- A12: saved views as LIVE include/exclude sets. Each referenced view resolves to its
  -- current membership (its own stored filters, source and mode) via correlated EXISTS
  -- anti-joins (NOT IN over 770k ids planned as an O(n^2) null-aware subplan and timed out).
  -- Requires the outer agents relation to be aliased "a" (fn_filter_search / fn_filter_ids).
  -- INCLUDE = agent in ANY selected view (union — multiple lead lists compose additively);
  -- EXCLUDE = agent in NONE of the selected views. A referenced view's own nested saved-view
  -- refs are stripped (depth 1 -> cycles impossible); broken/deleted views are skipped.
  f := p_filters->'savedViews';
  if f is not null then
    for side in select unnest(array['include', 'exclude']) loop
      kconds := '{}';
      if jsonb_typeof(f->side) = 'array' then
        for view_id in select jsonb_array_elements_text(f->side) loop
          begin
            select filters, coalesce(mode, 'agent'), coalesce(source_mode, 'courted')
              into vv, vmode, vsrc from saved_lists where id = view_id::uuid;
            if vv is not null then
              vv := vv - 'savedViews';
              if vmode = 'office' then
                kconds := kconds || format('a.office_id in (select o9.id from offices o9 where (%s))', fn_office_where(vv));
              else
                kconds := kconds || format('a.id in (select a9.id from agents a9 where (%s))', fn_agent_where(vsrc, vv));
              end if;
            end if;
          exception when others then
            null; -- deleted id / malformed stored filters: skip this view, keep the search alive
          end;
        end loop;
      end if;
      if array_length(kconds, 1) > 0 then
        if side = 'exclude' then
          parts := parts || ('not (' || array_to_string(kconds, ' or ') || ')');
        else
          parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
        end if;
      end if;
    end loop;
  end if;

  f := p_filters->'title';
  if f is not null then
    -- title may hold multiple titles separated by comma or slash (e.g. 'Salesperson, Team Leader').
    -- Match per token, ignoring case/spacing/punctuation ('sales person' == 'Salesperson').
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format(
        'array(select regexp_replace(lower(t), ''[^a-z0-9]'', '''', ''g'') from unnest(string_to_array(title, '','')) t) && %L::text[]',
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'include') x(v)));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format(
        '(title is null or not (array(select regexp_replace(lower(t), ''[^a-z0-9]'', '''', ''g'') from unnest(string_to_array(title, '','')) t) && %L::text[]))',
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'exclude') x(v)));
    end if;
  end if;

  f := p_filters->'license';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('license_number = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(license_number is null or license_number <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  f := p_filters->'name';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'include') loop
        kconds := kconds || format('full_name ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'exclude') loop
        kconds := kconds || format('full_name not ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(full_name is null or (' || array_to_string(kconds, ' and ') || '))'); end if;
    end if;
  end if;

  f := p_filters->'zillowRealtor';
  if f is not null then
    if jsonb_array_length(coalesce(f->'languages', '[]'::jsonb)) > 0 then
      parts := parts || format('exists (select 1 from unnest(coalesce(languages, array[]::text[])) lang where lower(lang) = any(%L::text[]))',
        array(select lower(jsonb_array_elements_text(f->'languages'))));
    end if;
    c := fn_range_cond('total_sales_all_time', f->'totalSales'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_price_all_time', f->'avgPriceAllTime'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_sales_volume_all_time', f->'avgVolumeAllTime'); if c is not null then parts := parts || c; end if;
    if (f->>'hasLinkedin') = 'true' then parts := parts || 'linkedin_url is not null'::text; end if;
  end if;

  -- A3: contact has/missing (email presence counts preferred OR enriched)
  f := p_filters->'contact';
  if f is not null then
    if f->>'email' = 'has' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is not null'::text;
    elsif f->>'email' = 'missing' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text;
    end if;
    if f->>'phone' = 'has' then
      parts := parts || '(preferred_phone is not null and preferred_phone <> '''')'::text;
    elsif f->>'phone' = 'missing' then
      parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text;
    end if;
  end if;

  -- legacy missingContact (old saved views)
  f := p_filters->'missingContact';
  if f is not null then
    if (f->>'email') = 'true' then parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text; end if;
    if (f->>'phone') = 'true' then parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text; end if;
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_search_options(p_type text, p_q text DEFAULT ''::text, p_field text DEFAULT NULL::text, p_scope text DEFAULT 'agent'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q text := coalesce(p_q, '');
  v_scope text := case when p_scope = 'office' then 'office' else 'agent' end;
  res jsonb;
begin
  if p_type = 'location' then
    -- object options with counts, ordered by reach; totals for the live header (C2)
    select jsonb_build_object(
      'options', coalesce((
        select jsonb_agg(jsonb_build_object('v', value, 'n', agent_count, 'var', variants) order by agent_count desc, value)
          from (select value, agent_count, variants from location_options
                 where location_options.scope = v_scope and field = coalesce(p_field, 'city')
                   and (q = '' or value ilike '%' || q || '%')
                 order by agent_count desc, value limit 100) t), '[]'::jsonb),
      'total', (select count(*) from location_options
                 where location_options.scope = v_scope and field = coalesce(p_field, 'city')
                   and (q = '' or value ilike '%' || q || '%')),
      'agents', (select coalesce(sum(agent_count), 0) from location_options
                  where location_options.scope = v_scope and field = coalesce(p_field, 'city')
                    and (q = '' or value ilike '%' || q || '%')))
      into res;
    return res;

  elsif p_type = 'brand' or p_type = 'office' then
    -- strings, highest agent count first (A2)
    select coalesce(jsonb_agg(value order by agent_count desc, value), '[]'::jsonb) into res
      from (select value, agent_count from location_options
             where scope = 'agent' and field = p_type and (q = '' or value ilike '%' || q || '%')
             order by agent_count desc, value limit 50) t;
    return res;

  elsif p_type = 'mls' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) order by name nulls last, code), '[]'::jsonb)
      into res from mls where q = '' or name ilike q || '%' or code ilike q || '%';
    return res;

  elsif p_type = 'title' then
    -- distinct title tokens across comma/slash-separated values, most common raw
    -- spelling as display, biggest agent reach first
    select coalesce(jsonb_agg(disp order by n desc, disp), '[]'::jsonb) into res
      from (
        select mode() within group (order by btrim(t) collate "C") as disp, count(*) as n
          from agents, unnest(string_to_array(title, ',')) t
         where title is not null and btrim(t) <> ''
         group by regexp_replace(lower(t), '[^a-z0-9]', '', 'g')
      ) s;
    return res;

  elsif p_type = 'license' then
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct license_number v from agents where license_number is not null and license_number ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;

  elsif p_type = 'name' then
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct full_name v from agents where full_name is not null and full_name ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;
  end if;

  return '[]'::jsonb;
end;
$function$;

grant execute on function fn_agent_where(text, jsonb) to anon, authenticated;
grant execute on function fn_search_options(text, text, text, text) to anon, authenticated;
