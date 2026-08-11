-- 0077: the Location filter's options follow the selected MLS (A15).
--
-- fn_search_options gains p_mls uuid[]. When the caller passes selected MLS ids (agent scope),
-- the location branch reads the precomputed per-MLS table from 0075/0076 instead of the global
-- location_options — so the dropdown offers only places those MLSs' agents are actually in,
-- with counts scoped to them, at all four levels (city / zip / county / state).
--
-- Before: selecting ARMLS (Arizona) still listed Miami, Houston and Chicago, with global counts.
-- After:  Scottsdale AZ 12,282 / Phoenix AZ 5,727 / Gilbert AZ 3,497 ...
--
-- The old 4-argument function is DROPPED rather than replaced. Adding a defaulted 5th argument
-- via CREATE OR REPLACE would leave both signatures in place, and an existing 4-argument call
-- would then match both and fail as ambiguous. Drop + create runs in one transaction, so there
-- is no window where the function is missing.
--
-- Passing no MLS ids keeps the previous behaviour exactly, so every other caller is unaffected.

DROP FUNCTION IF EXISTS public.fn_search_options(text, text, text, text);

CREATE OR REPLACE FUNCTION public.fn_search_options(p_type text, p_q text DEFAULT ''::text, p_field text DEFAULT NULL::text, p_scope text DEFAULT 'agent'::text, p_mls uuid[] DEFAULT NULL::uuid[])
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
    -- A15: with MLS(es) selected, offer only the places those MLSs' agents are actually in,
    -- and count within them. Reads the precomputed location_options_mls (0075/0076): computing
    -- this live costs 11-12 s for the largest MLS on this instance, versus ~9-21 ms here.
    -- Agent scope only -- that table is built from agent_mls, while Office/Brand scope their
    -- MLS filter through office_mls, so those views keep the unscoped list.
    if v_scope = 'agent' and p_mls is not null and array_length(p_mls, 1) > 0 then
      select jsonb_build_object(
        'options', coalesce((select jsonb_agg(jsonb_build_object('v', value, 'n', n, 'var', var) order by n desc, value)
                               from (select value, sum(agent_count)::int as n, max(variants) as var
                                       from location_options_mls
                                      where mls_id = any(p_mls) and field = coalesce(p_field, 'city')
                                        and (q = '' or value ilike '%' || q || '%')
                                      group by value order by n desc, value limit 100) t), '[]'::jsonb),
        'total',  (select count(*) from (select value from location_options_mls
                                          where mls_id = any(p_mls) and field = coalesce(p_field, 'city')
                                            and (q = '' or value ilike '%' || q || '%') group by value) c),
        'agents', (select coalesce(sum(agent_count), 0) from location_options_mls
                    where mls_id = any(p_mls) and field = coalesce(p_field, 'city')
                      and (q = '' or value ilike '%' || q || '%')))
        into res;
      return res;
    end if;

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
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'updated', to_char(bulk_refreshed_at, 'YYYY-MM-DD'), 'agents', member_agents, 'ready', coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)) order by name nulls last, code), '[]'::jsonb)
      into res from mls where q = '' or name ilike '%' || q || '%' or code ilike '%' || q || '%' or exists (select 1 from unnest(coalesce(aliases, '{}')) al where al ilike '%' || q || '%');
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
    -- the top bar accepts names, emails, and phone numbers
    if position('@' in q) > 0 then
      execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
        from (select distinct v from (
                select preferred_email v from agents where preferred_email ilike %1$L
                union all select enriched_email from agents where enriched_email ilike %1$L
                union all select source_ids->'agent_provided'->>'email' from agents where source_ids->'agent_provided'->>'email' ilike %1$L
              ) u where v is not null order by 1 limit 50) s$f$, '%' || q || '%') into res;
      return res;
    elsif length(regexp_replace(q, '[^0-9]', '', 'g')) >= 7 then
      execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
        from (select distinct preferred_phone v from agents
               where preferred_phone_digits like %L and preferred_phone is not null order by 1 limit 50) s$f$,
        '%' || regexp_replace(q, '[^0-9]', '', 'g') || '%') into res;
      return res;
    end if;
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct full_name v from agents where full_name is not null and full_name ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;
  end if;

  return '[]'::jsonb;
end;
$function$

;
