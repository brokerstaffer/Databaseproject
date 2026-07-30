-- 0064: top-bar search understands emails and phone numbers.
-- '@' in the term -> rank/suggest by preferred, enriched, and agent-provided emails;
-- 7+ digits -> match on a stored digits-only phone column (no per-row regex at query
-- time); anything else -> names, as before.
alter table agents add column if not exists preferred_phone_digits text
  generated always as (regexp_replace(coalesce(preferred_phone, ''), '[^0-9]', '', 'g')) stored;

CREATE OR REPLACE FUNCTION public.fn_agent_order(p_filters jsonb, p_sort_by text, p_sort_dir text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when coalesce(p_filters->>'nameQuery', '') = '' then ''
    when position('@' in p_filters->>'nameQuery') > 0
      then format('(preferred_email ilike %1$L or enriched_email ilike %1$L or (source_ids->''agent_provided''->>''email'') ilike %1$L) desc nulls last, ',
                  '%' || (p_filters->>'nameQuery') || '%')
    when length(regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g')) >= 7
      then format('(preferred_phone_digits like %L) desc nulls last, ',
                  '%' || regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g') || '%')
    else format('(full_name ilike %L) desc nulls last, ', '%' || (p_filters->>'nameQuery') || '%') end
  || format('%I %s nulls last',
       case p_sort_by
         when 'full_name' then 'full_name' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
         when 'closed_transactions' then 'closed_transactions' when 'est_time_in_industry_months' then 'est_time_in_industry_months'
         when 'license_number' then 'license_number' when 'title' then 'title' when 'office_name' then 'office_name'
         when 'est_time_at_office_months' then 'est_time_at_office_months' when 'avg_time_at_office_months' then 'avg_time_at_office_months'
         when 'approx_gci' then 'approx_gci' when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
         when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
         when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
         when 'pct_change' then 'pct_change' when 'home_city' then 'home_city' when 'home_zip' then 'home_zip'
         when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' when 'brand' then 'brand'
         when 'most_transacted_city' then 'most_transacted_city'
         when 'preferred_email' then 'preferred_email' when 'preferred_phone' then 'preferred_phone'
         when 'total_sales_all_time' then 'total_sales_all_time' when 'avg_price_all_time' then 'avg_price_all_time'
         when 'avg_sales_volume_all_time' then 'avg_sales_volume_all_time'
         when 'linkedin_url' then 'linkedin_url'
         when 'mls' then 'primary_mls_code'
         else 'sales_volume' end,
       case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
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
    -- B2: options as {v, n} objects so the UI can show reach, same as Location does
    select coalesce(jsonb_agg(jsonb_build_object('v', value, 'n', agent_count) order by agent_count desc, value), '[]'::jsonb) into res
      from (select value, agent_count from location_options
             where scope = 'agent' and field = p_type and (q = '' or value ilike '%' || q || '%')
             order by agent_count desc, value limit 50) t;
    return res;

  elsif p_type = 'mls' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'updated', to_char(bulk_refreshed_at, 'YYYY-MM-DD'), 'agents', member_agents) order by name nulls last, code), '[]'::jsonb)
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
$function$;

grant execute on function fn_agent_order(jsonb, text, text) to anon, authenticated;
grant execute on function fn_search_options(text, text, text, text) to anon, authenticated;
