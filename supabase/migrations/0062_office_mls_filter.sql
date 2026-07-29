-- 0062: MLS filter for the Office and Brand views — offices resolve via office_mls.

CREATE OR REPLACE FUNCTION public.fn_office_where(p_filters jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; col text; field text; side text; c text; v text; vst text; vbase text;
  vconds text[];
  v_client_ids text[];
begin
  -- LOCATION (A14: include + exclude; exclude keeps NULL-location offices)
  f := p_filters->'location';
  if f is not null then
    field := coalesce(f->>'field', 'city');
    foreach side in array array['values', 'excludeValues'] loop
        field := case when side = 'excludeValues' then coalesce(nullif(f->>'excludeField', ''), f->>'field') else f->>'field' end; -- D3: exclude may target a different geography level
      if jsonb_typeof(f->side) = 'array' and jsonb_array_length(f->side) > 0 then
        vconds := '{}';
        if field = 'city' or field = 'county' then
          -- state-grouped = ANY(keys): one key evaluation per row (see fn_agent_where)
          arr := array(select distinct case when field = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end
                       from jsonb_array_elements_text(f->side) x(v)
                       where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is null
                         and (case when field = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end) is not null);
          if array_length(arr, 1) > 0 then
            if field = 'city' then
              vconds := vconds || format('office_city_key = ANY(%L::text[])', arr);
            else
              vconds := vconds || format('lower(office_county) = ANY(%L::text[])', arr);
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
                vconds := vconds || format('(office_city_key = ANY(%L::text[]) and coalesce(upper(office_state), fn_city_embedded_state(office_city)) = %L)', arr, vst);
              else
                vconds := vconds || format('(lower(office_county) = ANY(%L::text[]) and upper(office_state) = %L)', arr, vst);
              end if;
            end if;
          end loop;
        else
          arr := array(select jsonb_array_elements_text(f->side));
          col := case field when 'state' then 'office_state' when 'zip' then 'office_zip' else 'office_city' end;
          if field = 'state' then
            vconds := vconds || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
          else
            vconds := vconds || format('%I = ANY(%L::text[])', col, arr);
          end if;
        end if;
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
$function$;

grant execute on function fn_office_where(jsonb) to anon, authenticated;
