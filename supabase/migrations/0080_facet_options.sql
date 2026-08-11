-- 0080: filter options react to the other active filters (A15.B).
--
-- Until now every dropdown offered the same list regardless of what else was selected: with
-- "sales volume $100M+" applied, Location still listed all 17,457 cities, most of which contain
-- no such agent. This computes each dropdown's options against the CURRENT filters.
--
-- SELF-EXCLUSION -- the rule that makes it usable. When building options for a filter, every
-- OTHER filter applies but that filter itself is dropped. Without this, picking "Miami" would
-- collapse the city list to just Miami and you could never add Orlando. So:
--     location options  <- all filters except location
--     brand/office      <- all filters except officeSearch
--     mls options       <- all filters except mls / multiMls / mlsCount
--
-- COST. After 0079 the live aggregation is cleanly linear at roughly 10 microseconds per agent
-- in the measured set:
--       857 agents ->   82 ms
--    29,395 agents ->  334 ms
--    76,633 agents ->  768 ms
--   119,517 agents -> 1,107 ms
-- 1,133,067 agents -> 11,158 ms
-- So it is fast exactly when it is useful (you have narrowed down) and slow only when the set
-- is nearly the whole database -- where the scoped list would equal the global list anyway.
-- Hence the guard: above FACET_GUARD agents, fall through to the precomputed answer. That is
-- correctness, not a compromise.
--
-- The guard is applied with "limit FACET_GUARD+1", so a broad set short-circuits as soon as
-- enough rows are seen rather than counting all 1.1M.
--
-- Two fast paths avoid the live query entirely:
--   * nothing else narrowing        -> fn_search_options (the precomputed global lists)
--   * only MLS narrowing + location -> location_options_mls (A15's per-MLS table, ~9-21 ms)
--
-- Output shapes are IDENTICAL to fn_search_options for every type, so callers can swap freely:
--   location   -> { options:[{v,n,var}], total, agents }
--   brand/office -> [{v,n}]
--   mls        -> [{id,code,name,updated,agents,ready}]

CREATE OR REPLACE FUNCTION public.fn_facet_options(
  p_type    text,
  p_q       text    DEFAULT ''::text,
  p_field   text    DEFAULT NULL::text,
  p_source  text    DEFAULT 'courted'::text,
  p_filters jsonb   DEFAULT '{}'::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '128MB'
AS $function$
declare
  FACET_GUARD constant bigint := 150000;  -- above this the scoped list ~= the global list
  q       text  := coalesce(p_q, '');
  vf      jsonb := coalesce(p_filters, '{}'::jsonb);
  v_field text  := coalesce(p_field, 'city');
  v_where text;
  v_base  text;
  v_n     bigint;
  res     jsonb;
  sel_mls uuid[];
  v_cols  text;
begin
  -- ---- self-exclusion: drop the filter whose own options we are building ----
  if p_type = 'location' then
    vf := vf - 'location';
  elsif p_type in ('brand', 'office') then
    vf := vf - 'officeSearch';
  elsif p_type = 'mls' then
    vf := vf - 'mls' - 'multiMls' - 'mlsCount';
  else
    -- title / licence / name are near-unique or tiny; scoping them buys nothing
    return fn_search_options(p_type, q, p_field, 'agent', null);
  end if;

  v_where := fn_agent_where(p_source, vf);
  v_base  := fn_agent_where(p_source, '{}'::jsonb);   -- what "no narrowing filters" looks like

  -- ---- fast path 1: nothing else is narrowing -> the precomputed global lists ARE the answer
  if v_where = v_base then
    return fn_search_options(p_type, q, p_field, 'agent', null);
  end if;

  -- ---- fast path 2: MLS is the only thing narrowing a LOCATION facet -> A15's per-MLS table
  if p_type = 'location'
     and jsonb_array_length(coalesce(vf->'mls'->'include', '[]'::jsonb)) > 0
     and fn_agent_where(p_source, vf - 'mls' - 'multiMls' - 'mlsCount') = v_base then
    sel_mls := array(select (jsonb_array_elements_text(vf->'mls'->'include'))::uuid);
    return fn_search_options('location', q, p_field, 'agent', sel_mls);
  end if;

  -- ---- guard: is the remaining set small enough to aggregate live? ----
  execute format('select count(*) from (select 1 from agents a where %s limit %s) x',
                 v_where, FACET_GUARD + 1)
    into v_n;
  if v_n > FACET_GUARD then
    -- too broad to be worth scoping, and the scoped list would barely differ
    return fn_search_options(p_type, q, p_field, 'agent', null);
  end if;

  -- =====================  LIVE FACETS  =====================
  if p_type = 'location' then
    -- one row per (agent, location-kind); DISTINCT so an agent whose office AND home are in the
    -- same place counts once there. Display name joins from location_options, with a synthesised
    -- fallback so a place that exists only in this slice is never dropped (see 0076).
    v_cols := case v_field
      when 'city' then $c$(a.office_city_key, coalesce(upper(a.office_state), fn_city_embedded_state(a.office_city), '')),
                         (a.home_city_key, coalesce(upper(a.home_state), fn_city_embedded_state(a.home_city), '')),
                         (a.most_transacted_city_key, coalesce(upper(a.transacted_state), fn_city_embedded_state(a.most_transacted_city), ''))$c$
      when 'zip'  then $c$(lower(a.office_zip), ''), (lower(a.home_zip), ''), (lower(a.most_transacted_zip), '')$c$
      when 'county' then $c$(lower(a.office_county), upper(coalesce(a.office_state,''))),
                           (lower(a.home_county), upper(coalesce(a.home_state,''))),
                           (lower(a.most_transacted_county), upper(coalesce(a.transacted_state,'')))$c$
      else $c$(lower(a.office_state), ''), (lower(a.home_state), ''), (lower(a.transacted_state), '')$c$
    end;

    execute format($q$
      with lat as (
        select a.id, v.k, v.st from agents a
        cross join lateral (values %s) v(k, st)
        where (%s) and v.k is not null and v.k <> ''
          and not (%L = 'city' and (v.k ~ '\d{3,}'
                   or v.k in ('other','unknown','null','n/a','na','none','city','test','tbd','various')))
      ),
      d as (select distinct k, st, id from lat),
      g as (select k, st, count(*)::int n from d group by 1, 2),
      o as (
        select coalesce(lo.value,
                        case %L when 'state' then upper(g.k) when 'zip' then g.k
                                else initcap(g.k) || case when g.st <> '' then ', ' || g.st else '' end end) as value,
               g.n, coalesce(lo.variants, 1) as var
          from g left join location_options lo
            on lo.scope='agent' and lo.field=%L and lo.key=g.k and lo.state=g.st
      ),
      f as (select value, sum(n)::int n, max(var) var from o where (%L = '' or value ilike %L) group by value)
      select jsonb_build_object(
        'options', coalesce((select jsonb_agg(jsonb_build_object('v', value, 'n', n, 'var', var) order by n desc, value)
                               from (select * from f order by n desc, value limit 100) t), '[]'::jsonb),
        'total',   (select count(*) from f),
        'agents',  (select coalesce(sum(n), 0) from f))
    $q$, v_cols, v_where, v_field, v_field, v_field, q, '%' || q || '%')
    into res;
    return res;

  elsif p_type in ('brand', 'office') then
    -- grouped on the lowered value and displayed from location_options, matching how the
    -- unscoped list is built (so the string the user picks still matches the filter exactly)
    execute format($q$
      with g as (
        select lower(a.%1$I) k, count(*)::int n from agents a
         where (%2$s) and a.%1$I is not null group by 1
      ),
      o as (
        select coalesce(lo.value, initcap(g.k)) as value, g.n
          from g left join location_options lo on lo.scope='agent' and lo.field=%3$L and lo.key=g.k
      )
      select coalesce(jsonb_agg(jsonb_build_object('v', value, 'n', n) order by n desc, value), '[]'::jsonb)
        from (select value, sum(n)::int n from o where (%4$L = '' or value ilike %5$L) group by value
               order by n desc, value limit 50) t
    $q$, case when p_type = 'brand' then 'brand' else 'office_name' end, v_where, p_type, q, '%' || q || '%')
    into res;
    return res;

  else  -- mls
    execute format($q$
      with sel as (select a.id from agents a where %s)
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'code', t.code, 'name', t.name,
               'updated', t.updated, 'agents', t.n, 'ready', t.ready) order by t.n desc, t.code), '[]'::jsonb)
        from (
          select m.id, m.code, m.name, to_char(m.bulk_refreshed_at,'YYYY-MM-DD') as updated,
                 count(*)::int as n,
                 coalesce(m.stats_agents,0)::numeric >= 0.9 * greatest(coalesce(m.member_agents,0),1) as ready
            from sel join agent_mls am on am.agent_id = sel.id join mls m on m.id = am.mls_id
           where (%L = '' or m.name ilike %L or m.code ilike %L)
           group by m.id, m.code, m.name, m.bulk_refreshed_at, m.stats_agents, m.member_agents
        ) t
    $q$, v_where, q, '%' || q || '%', '%' || q || '%')
    into res;
    return res;
  end if;
end;
$function$;
