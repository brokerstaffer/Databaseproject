-- 0048 (B2 + A8 display): brand/office filter options return {v, n} with the agent
-- count (already computed in location_options, previously discarded); MLS options gain
-- the per-MLS bulk-refresh date and member count from 0046.

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
    -- B2: options as {v, n} objects so the UI can show reach, same as Location does
    select coalesce(jsonb_agg(jsonb_build_object('v', value, 'n', agent_count) order by agent_count desc, value), '[]'::jsonb) into res
      from (select value, agent_count from location_options
             where scope = 'agent' and field = p_type and (q = '' or value ilike '%' || q || '%')
             order by agent_count desc, value limit 50) t;
    return res;

  elsif p_type = 'mls' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'updated', to_char(bulk_refreshed_at, 'YYYY-MM-DD'), 'agents', member_agents) order by name nulls last, code), '[]'::jsonb)
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

grant execute on function fn_search_options(text, text, text, text) to anon, authenticated;
