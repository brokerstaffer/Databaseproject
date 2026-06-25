-- 0007_search_options.sql
-- Typeahead options for Location / Brand / Office / MLS / Title filters, and the
-- "Current clients using this MLS" lookup. SECURITY DEFINER; granted anon+authenticated.

create or replace function fn_search_options(p_type text, p_field text default null, p_q text default '')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q text := coalesce(p_q, '');
  cols text[];
  sql text;
  res jsonb;
begin
  if p_type = 'location' then
    cols := case coalesce(p_field, 'city')
      when 'city'   then array['office_city', 'home_city', 'most_transacted_city']
      when 'zip'    then array['office_zip', 'home_zip', 'most_transacted_zip']
      when 'county' then array['office_county', 'home_county', 'most_transacted_county']
      when 'state'  then array['office_state', 'home_state', 'transacted_state']
      else array['office_city', 'home_city', 'most_transacted_city'] end;
    sql := format($f$
      select coalesce(jsonb_agg(v order by v), '[]'::jsonb) from (
        select distinct v from (
          select %1$I v from agents where %1$I ilike %4$L
          union all select %2$I from agents where %2$I ilike %4$L
          union all select %3$I from agents where %3$I ilike %4$L
        ) u where v is not null and v <> '' order by 1 limit 50
      ) s
    $f$, cols[1], cols[2], cols[3], q || '%');
    execute sql into res;
    return res;

  elsif p_type = 'brand' then
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct brand v from agents where brand is not null and brand ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;

  elsif p_type = 'office' then
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct office_name v from agents where office_name is not null and office_name ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;

  elsif p_type = 'mls' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) order by name), '[]'::jsonb)
      into res from mls where q = '' or name ilike q || '%' or code ilike q || '%';
    return res;

  elsif p_type = 'title' then
    select coalesce(jsonb_agg(distinct title), '[]'::jsonb) into res from agents where title is not null;
    return res;

  elsif p_type = 'license' then
    execute format($f$select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (select distinct license_number v from agents where license_number is not null and license_number ilike %L order by 1 limit 50) s$f$, q || '%') into res;
    return res;
  end if;

  return '[]'::jsonb;
end;
$$;

grant execute on function fn_search_options(text, text, text) to anon, authenticated;

-- "Current clients using this MLS": provided seed (client_mls) + saved lists whose filters select that MLS.
create or replace function fn_clients_for_mls(p_mls_ids uuid[])
returns text[]
language sql stable security definer set search_path = public as $$
  with ids as (select array_agg(id::text) t from unnest(p_mls_ids) id)
  select coalesce(array_agg(distinct name), '{}') from (
    select client_name as name from client_mls where mls_id = any(p_mls_ids)
    union
    select sl.name from saved_lists sl, ids
      where coalesce(sl.filters->'mls'->'include', '[]'::jsonb) ?| ids.t
  ) s where name is not null;
$$;

grant execute on function fn_clients_for_mls(uuid[]) to anon, authenticated;
