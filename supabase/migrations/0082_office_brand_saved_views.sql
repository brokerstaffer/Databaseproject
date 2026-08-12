-- 0082: saved views work in the Office and Brand views too (A21b).
--
-- Saved views already narrowed the three agent-grained modes (Agent, MLS, Location) because
-- those build their WHERE with fn_agent_where. Office and Brand run on fn_office_where, which
-- had no saved-view handling, so the control was hidden there and the filter silently ignored.
--
-- SEMANTICS, as chosen by the client: a saved view is a list of AGENTS, so at office grain it
-- means "the offices those agents work at" -- an office qualifies when ANY of its agents is in
-- the view. That is the reading that matches how the views are actually built (they are lead
-- lists), and it makes "show me the offices behind my Camelot list" work directly.
-- A view that was itself saved in Office mode is matched as offices, not expanded through
-- agents, so office-mode views keep meaning what they meant.
--
-- Include = the office matches ANY chosen view; exclude = it matches none. Both carry the same
-- protections as the agent-grain version: nested saved-view references are stripped (depth 1,
-- so cycles are impossible) and a deleted or malformed view is skipped rather than failing the
-- whole search.
--
-- Brand view gets this for free -- it filters offices with the same function before grouping.

CREATE OR REPLACE FUNCTION public.fn_office_where(p_filters jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare grp record;
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; col text; field text; side text; c text; v text; vst text; vbase text;
  vconds text[];
  v_client_ids text[];
  kconds text[]; vv jsonb; vmode text; vsrc text; view_id text;
begin
  -- LOCATION (A14: include + exclude; exclude keeps NULL-location offices)
  f := p_filters->'location';
  if f is not null then
    field := coalesce(f->>'field', 'city');
    foreach side in array array['values', 'excludeValues'] loop
        field := case when side = 'excludeValues' then coalesce(nullif(f->>'excludeField', ''), f->>'field') else f->>'field' end; -- D3: exclude may target a different geography level
      if jsonb_typeof(f->side) = 'array' and jsonb_array_length(f->side) > 0 then
        vconds := '{}';
        for grp in
          select coalesce(case when jsonb_typeof(e.value) = 'object' then nullif(e.value->>'f', '') end, field) as ef,
                 jsonb_agg(case when jsonb_typeof(e.value) = 'object' then e.value->>'v' else e.value #>> '{}' end) as vals
            from jsonb_array_elements(f->side) e
           group by 1
        loop
        if grp.ef = 'city' or grp.ef = 'county' then
          -- state-grouped = ANY(keys): one key evaluation per row (see fn_agent_where)
          arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end
                       from jsonb_array_elements_text(grp.vals) x(v)
                       where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is null
                         and (case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end) is not null);
          if array_length(arr, 1) > 0 then
            if grp.ef = 'city' then
              vconds := vconds || format('office_city_key = ANY(%L::text[])', arr);
            else
              vconds := vconds || format('lower(office_county) = ANY(%L::text[])', arr);
            end if;
          end if;
          for vst in select distinct upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1])
                     from jsonb_array_elements_text(grp.vals) x(v)
                     where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is not null loop
            arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) else lower(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) end
                         from jsonb_array_elements_text(grp.vals) x(v)
                         where upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1]) = vst);
            arr := array(select y from unnest(arr) y where y is not null);
            if array_length(arr, 1) > 0 then
              if grp.ef = 'city' then
                vconds := vconds || format('(office_city_key = ANY(%L::text[]) and coalesce(upper(office_state), fn_city_embedded_state(office_city)) = %L)', arr, vst);
              else
                vconds := vconds || format('(lower(office_county) = ANY(%L::text[]) and upper(office_state) = %L)', arr, vst);
              end if;
            end if;
          end loop;
        else
          arr := array(select jsonb_array_elements_text(grp.vals));
          col := case grp.ef when 'state' then 'office_state' when 'zip' then 'office_zip' else 'office_city' end;
          if grp.ef = 'state' then
            vconds := vconds || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
          else
            vconds := vconds || format('%I = ANY(%L::text[])', col, arr);
          end if;
        end if;
        end loop;
        if array_length(vconds, 1) > 0 then
          if side = 'excludeValues' then
            parts := parts || ('not coalesce((' || array_to_string(vconds, ' or ') || '), false)');
          else
            parts := parts || ('(' || array_to_string(vconds, ' or ') || ')');
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

  f := p_filters->'agentCount';
  if f is not null then c := fn_range_cond('agent_count', f); if c is not null then parts := parts || c; end if; end if;

  -- MLS filter at office grain (office_mls junction) — feeds the Office AND Brand views
  f := p_filters->'mls';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('id in (select office_id from office_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('id not in (select office_id from office_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  -- A21b: saved views at OFFICE grain. A saved view is a list of AGENTS, so at this grain it
  -- means "the offices those agents work at" -- an office qualifies if any of its agents is in
  -- the view. A view that was itself saved in Office mode is matched as offices directly.
  -- Include = office matches ANY chosen view; exclude = matches none. Same depth-1 cap and
  -- same skip-broken-views guard as the agent-grain version in fn_agent_where.
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
                kconds := kconds || format('id in (select o9.id from offices o9 where (%s))', fn_office_where(vv));
              else
                kconds := kconds || format('id in (select a9.office_id from agents a9 where a9.office_id is not null and (%s))', fn_agent_where(vsrc, vv));
              end if;
            end if;
          exception when others then
            null; -- deleted id / malformed stored filters: skip it, keep the search alive
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

  v_client_ids := case
    when jsonb_typeof(p_filters->'orchClientIds') = 'array' and jsonb_array_length(p_filters->'orchClientIds') > 0
      then array(select jsonb_array_elements_text(p_filters->'orchClientIds'))
    when coalesce(p_filters->>'orchClientId', '') <> ''
      then array[p_filters->>'orchClientId']
    else null end;
  if v_client_ids is not null then
    if coalesce(p_filters->>'orchClientMode', 'include') = 'exclude' then
      parts := parts || format('id not in (select a.office_id from agents a join (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id)) s on s.agent_id = a.id where a.office_id is not null)', v_client_ids);
    else
      parts := parts || format('id in (select a.office_id from agents a join (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id)) s on s.agent_id = a.id where a.office_id is not null)', v_client_ids);
    end if;
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$function$

;
