-- 0035_filters_and_location_engine.sql
-- Client final-feedback round, phases 1+2:
--   A1  purge junk mls rows (Courted profile URLs / bare numbers ingested as "codes")
--   A3  contact filter: has/missing email + has/missing phone (replaces missingContact;
--       legacy key still honored for old saved views)
--   A5  multi-MLS filter (agents affiliated with 2+ MLSs)
--   A2/A7/C2  fn_search_options v2: options served from a precomputed location_options table
--       (instant, agent-count-ordered, City+ST display with variant counts); brand/office
--       ordered by agent count
--   A8  location options get a scope: agent (3-column union) vs office (offices table only)
--   C1  stop rewriting city casing at ingest (norm triggers dropped); matching moves to an
--       IMMUTABLE fn_city_match_key (case-insensitive, junk-suffix tolerant) with functional
--       indexes; stored values stay as the source sends them; most_transacted_city restored
--       to the raw scraper value from the per-source stash
--   C1/C2  location filter matches city+state composites ("Miami, FL"); bare legacy values
--       ("Miami") still match city-only
-- Idempotent.

set statement_timeout = 600000;

-- ======================= A1: mls junk purge =======================
delete from office_mls where mls_id in (select id from mls where code is null or code ~ '^https?://' or length(code) > 20 or code ~ '^[0-9]+$');
delete from agent_mls where mls_id in (select id from mls where code is null or code ~ '^https?://' or length(code) > 20 or code ~ '^[0-9]+$');
delete from mls where code is null or code ~ '^https?://' or length(code) > 20 or code ~ '^[0-9]+$';

-- ======================= C1: match key + indexes; stop rewriting =======================
-- Case-insensitive, punctuation/suffix-tolerant key for grouping and matching city values.
-- IMMUTABLE (regex-only — no dictionary lookups) so it can back functional indexes.
create or replace function fn_city_match_key(p text) returns text
language sql immutable as $$
  select nullif(lower(trim(regexp_replace(
    regexp_replace(regexp_replace(
      split_part(regexp_replace(trim(coalesce(p, '')), '\s*\([^)]*\)\s*$', ''), ',', 1),
      '\s+\d{5}(-\d{4})?$', ''), '[\s.,;:]+$', ''),
    '\s+', ' ', 'g'))), '')
$$;
grant execute on function fn_city_match_key(text) to anon, authenticated;

create index if not exists idx_agents_office_city_key on agents (fn_city_match_key(office_city));
create index if not exists idx_agents_home_city_key on agents (fn_city_match_key(home_city));
create index if not exists idx_agents_transacted_city_key on agents (fn_city_match_key(most_transacted_city));
create index if not exists idx_offices_city_key on offices (fn_city_match_key(office_city));

-- stored values are no longer rewritten at ingest
drop trigger if exists trg_agent_norm_cities on agents;
drop trigger if exists trg_office_norm_city on offices;

-- restore the raw scraper value for most_transacted_city where the stash kept it
update agents
   set most_transacted_city = source_ids->'courted'->>'city'
 where source_ids->'courted'->>'city' is not null
   and most_transacted_city is distinct from source_ids->'courted'->>'city';

-- ======================= geo inference rekeyed to the match key =======================
create or replace function fn_refresh_city_geo() returns void
language sql security definer set search_path = public as $$
  truncate city_geo, city_state_geo;

  with ev as (
    select fn_city_match_key(city) as city_lower, upper(trim(state)) as state, county, count(*)::int as cnt
      from zip_codes
     where fn_city_match_key(city) is not null and nullif(trim(state), '') is not null and county is not null
     group by 1, 2, 3
    union all
    select fn_city_match_key(office_city), upper(office_state), office_county, count(*)::int
      from agents where office_city is not null and office_state is not null and office_county is not null and office_zip is not null
     group by 1, 2, 3
    union all
    select fn_city_match_key(home_city), upper(home_state), home_county, count(*)::int
      from agents where home_city is not null and home_state is not null and home_county is not null and home_zip is not null
     group by 1, 2, 3
    union all
    select fn_city_match_key(most_transacted_city), upper(transacted_state), most_transacted_county, count(*)::int
      from agents where most_transacted_city is not null and transacted_state is not null and most_transacted_county is not null and most_transacted_zip is not null
     group by 1, 2, 3
  ), agg as (
    select city_lower, state, county, sum(cnt)::int cnt from ev
     where city_lower is not null and state ~ '^[A-Z]{2}$'
       and city_lower !~ '[0-9]'
       and city_lower not in ('other', 'unknown', 'null', 'n/a', 'na', 'none', 'city', 'test', 'tbd', 'various')
     group by 1, 2, 3
  ), ranked as (
    select city_lower, state, county, cnt,
           sum(cnt) over (partition by city_lower, state)::int total,
           row_number() over (partition by city_lower, state order by cnt desc) rn
      from agg
  )
  insert into city_geo (city_lower, state, county, evidence)
  select city_lower, state,
         case when cnt::numeric / total >= 0.9 then county else null end,
         total
    from ranked where rn = 1;

  with ref_dominance as (
    select city_lower, max(share) as top_share from (
      select fn_city_match_key(city) city_lower, upper(trim(state)) state,
             count(*)::numeric / sum(count(*)) over (partition by fn_city_match_key(city)) as share
        from zip_codes
       where fn_city_match_key(city) is not null and nullif(trim(state), '') is not null
       group by 1, 2
    ) s group by 1
  ), by_state as (
    select g.city_lower, g.state, sum(g.evidence)::int cnt
      from city_geo g
      left join ref_dominance r on r.city_lower = g.city_lower
     where r.top_share is null or r.top_share >= 0.95
     group by 1, 2
  ), ranked as (
    select city_lower, state, cnt,
           sum(cnt) over (partition by city_lower)::int total,
           row_number() over (partition by city_lower order by cnt desc) rn
      from by_state
  )
  insert into city_state_geo (city_lower, state, evidence)
  select city_lower, state, total
    from ranked where rn = 1 and cnt::numeric / total >= 0.95;
$$;
select fn_refresh_city_geo();

create or replace function fn_agent_geo_derive() returns trigger
language plpgsql set search_path = public as $$
declare
  c text; s text; z text;
  changed boolean;
begin
  -- OFFICE
  changed := tg_op = 'INSERT'
    or new.office_city is distinct from old.office_city
    or new.office_state is distinct from old.office_state
    or new.office_zip is distinct from old.office_zip;
  if changed then
    z := case when new.office_zip is null then null else left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) end;
    if new.office_state is null or (tg_op = 'UPDATE' and new.office_city is distinct from old.office_city and new.office_state is not distinct from old.office_state) then
      s := null;
      if z is not null then select state into s from zip_codes where zip = z limit 1; end if;
      if s is null and new.office_city is not null then
        select state into s from city_state_geo where city_lower = fn_city_match_key(new.office_city);
      end if;
      if s is not null then new.office_state := s; end if;
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.office_city is not null and new.office_state is not null then
      select county into c from city_geo where city_lower = fn_city_match_key(new.office_city) and state = upper(new.office_state);
    end if;
    new.office_county := c;
  end if;

  -- HOME
  changed := tg_op = 'INSERT'
    or new.home_city is distinct from old.home_city
    or new.home_state is distinct from old.home_state
    or new.home_zip is distinct from old.home_zip;
  if changed then
    z := case when new.home_zip is null then null else left(regexp_replace(new.home_zip, '[^0-9]', '', 'g'), 5) end;
    if new.home_state is null or (tg_op = 'UPDATE' and new.home_city is distinct from old.home_city and new.home_state is not distinct from old.home_state) then
      s := null;
      if z is not null then select state into s from zip_codes where zip = z limit 1; end if;
      if s is null and new.home_city is not null then
        select state into s from city_state_geo where city_lower = fn_city_match_key(new.home_city);
      end if;
      if s is not null then new.home_state := s; end if;
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.home_city is not null and new.home_state is not null then
      select county into c from city_geo where city_lower = fn_city_match_key(new.home_city) and state = upper(new.home_state);
    end if;
    new.home_county := c;
  end if;

  -- MOST TRANSACTED
  changed := tg_op = 'INSERT'
    or new.most_transacted_city is distinct from old.most_transacted_city
    or new.transacted_state is distinct from old.transacted_state
    or new.most_transacted_zip is distinct from old.most_transacted_zip;
  if changed then
    z := case when new.most_transacted_zip is null then null else left(regexp_replace(new.most_transacted_zip, '[^0-9]', '', 'g'), 5) end;
    if new.transacted_state is null or (tg_op = 'UPDATE' and new.most_transacted_city is distinct from old.most_transacted_city and new.transacted_state is not distinct from old.transacted_state) then
      s := null;
      if z is not null then select state into s from zip_codes where zip = z limit 1; end if;
      if s is null and new.most_transacted_city is not null then
        select state into s from city_state_geo where city_lower = fn_city_match_key(new.most_transacted_city);
      end if;
      if s is not null then new.transacted_state := s; end if;
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.most_transacted_city is not null and new.transacted_state is not null then
      select county into c from city_geo where city_lower = fn_city_match_key(new.most_transacted_city) and state = upper(new.transacted_state);
    end if;
    new.most_transacted_county := c;
  end if;

  return new;
end;
$$;

create or replace function fn_office_geo_derive() returns trigger
language plpgsql set search_path = public as $$
declare c text; s text; z text; changed boolean;
begin
  changed := tg_op = 'INSERT'
    or new.office_city is distinct from old.office_city
    or new.office_state is distinct from old.office_state
    or new.office_zip is distinct from old.office_zip;
  if changed then
    z := case when new.office_zip is null then null else left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) end;
    if new.office_state is null or (tg_op = 'UPDATE' and new.office_city is distinct from old.office_city and new.office_state is not distinct from old.office_state) then
      s := null;
      if z is not null then select state into s from zip_codes where zip = z limit 1; end if;
      if s is null and new.office_city is not null then
        select state into s from city_state_geo where city_lower = fn_city_match_key(new.office_city);
      end if;
      if s is not null then new.office_state := s; end if;
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.office_city is not null and new.office_state is not null then
      select county into c from city_geo where city_lower = fn_city_match_key(new.office_city) and state = upper(new.office_state);
    end if;
    new.office_county := c;
  end if;
  return new;
end;
$$;

-- ======================= A2/A7/C2/A8: precomputed options =======================
create table if not exists location_options (
  scope text not null,          -- 'agent' (3-column union) | 'office' (offices table)
  field text not null,          -- city | zip | county | state | brand | office
  key text not null,            -- grouping key (match key / lowered value)
  state text not null default '',
  value text not null,          -- display value ("Miami, FL"; most common raw variant)
  agent_count int not null,     -- distinct agents (offices for scope='office')
  variants int not null default 1,
  primary key (scope, field, key, state)
);
grant select on location_options to anon, authenticated;

create table if not exists location_options_meta (
  id int primary key default 1,
  refreshed_at timestamptz not null default 'epoch'
);
insert into location_options_meta (id) values (1) on conflict do nothing;

create or replace function fn_refresh_location_options(p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not p_force and (select refreshed_at from location_options_meta where id = 1) > now() - interval '10 minutes' then
    return; -- debounce: ingest bursts call this after every chunk
  end if;
  update location_options_meta set refreshed_at = now() where id = 1;

  truncate location_options;

  -- agent-scope city (union of office/home/most-transacted, distinct agents per group)
  insert into location_options (scope, field, key, state, value, agent_count, variants)
  with rows as (
    select id, office_city raw, upper(coalesce(office_state, '')) st from agents where office_city is not null
    union all select id, home_city, upper(coalesce(home_state, '')) from agents where home_city is not null
    union all select id, most_transacted_city, upper(coalesce(transacted_state, '')) from agents where most_transacted_city is not null
  ), keyed as (
    select id, raw, st, fn_city_match_key(raw) k from rows where fn_city_match_key(raw) is not null
  ), grp as (
    select k, st, count(distinct id)::int agents, count(distinct raw)::int variants from keyed group by 1, 2
  ), disp as (
    select k, st, raw, row_number() over (partition by k, st order by count(*) desc, raw) rn
      from keyed group by k, st, raw
  )
  select 'agent', 'city', g.k, g.st,
         d.raw || case when g.st <> '' then ', ' || g.st else '' end,
         g.agents, g.variants
    from grp g join disp d on d.k = g.k and d.st = g.st and d.rn = 1;

  -- agent-scope zip / county / state
  insert into location_options (scope, field, key, state, value, agent_count)
  with rows as (
    select id, office_zip v from agents where office_zip is not null
    union all select id, home_zip from agents where home_zip is not null
    union all select id, most_transacted_zip from agents where most_transacted_zip is not null
  ), clean as (
    select id, v from rows where v !~* '^\s*(n/?a?|none|null|-+)\s*$'
  ), grp as (
    select lower(v) k, count(distinct id)::int n from clean group by 1
  ), disp as (
    select lower(v) k, v raw, row_number() over (partition by lower(v) order by count(*) desc, v) rn from clean group by lower(v), v
  )
  select 'agent', 'zip', g.k, '', d.raw, g.n from grp g join disp d on d.k = g.k and d.rn = 1;

  insert into location_options (scope, field, key, state, value, agent_count)
  with rows as (
    select id, office_county v, upper(coalesce(office_state, '')) st from agents where office_county is not null
    union all select id, home_county, upper(coalesce(home_state, '')) from agents where home_county is not null
    union all select id, most_transacted_county, upper(coalesce(transacted_state, '')) from agents where most_transacted_county is not null
  ), grp as (
    select lower(v) k, st, count(distinct id)::int n from rows group by 1, 2
  ), disp as (
    select lower(v) k, st, v raw, row_number() over (partition by lower(v), st order by count(*) desc, v) rn
      from rows group by lower(v), st, v
  )
  select 'agent', 'county', g.k, g.st, d.raw || case when g.st <> '' then ', ' || g.st else '' end, g.n
    from grp g join disp d on d.k = g.k and d.st = g.st and d.rn = 1;

  insert into location_options (scope, field, key, state, value, agent_count)
  with rows as (
    select id, upper(office_state) v from agents where office_state is not null
    union all select id, upper(home_state) from agents where home_state is not null
    union all select id, upper(transacted_state) from agents where transacted_state is not null
  )
  select 'agent', 'state', lower(v), '', v, count(distinct id)::int from rows group by v;

  -- office scope (counts are offices, sourced from the offices table only — A8)
  insert into location_options (scope, field, key, state, value, agent_count, variants)
  with keyed as (
    select id, office_city raw, upper(coalesce(office_state, '')) st, fn_city_match_key(office_city) k
      from offices where fn_city_match_key(office_city) is not null
  ), grp as (
    select k, st, count(distinct id)::int n, count(distinct raw)::int variants from keyed group by 1, 2
  ), disp as (
    select k, st, raw, row_number() over (partition by k, st order by count(*) desc, raw) rn from keyed group by k, st, raw
  )
  select 'office', 'city', g.k, g.st, d.raw || case when g.st <> '' then ', ' || g.st else '' end, g.n, g.variants
    from grp g join disp d on d.k = g.k and d.st = g.st and d.rn = 1;

  insert into location_options (scope, field, key, state, value, agent_count)
  with clean as (
    select office_zip v from offices where office_zip is not null and office_zip !~* '^\s*(n/?a?|none|null|-+)\s*$'
  ), grp as (
    select lower(v) k, count(*)::int n from clean group by 1
  ), disp as (
    select lower(v) k, v raw, row_number() over (partition by lower(v) order by count(*) desc, v) rn from clean group by lower(v), v
  )
  select 'office', 'zip', g.k, '', d.raw, g.n from grp g join disp d on d.k = g.k and d.rn = 1;
  insert into location_options (scope, field, key, state, value, agent_count)
  with grp as (
    select lower(office_county) k, upper(coalesce(office_state, '')) st, count(*)::int n
      from offices where office_county is not null group by 1, 2
  ), disp as (
    select lower(office_county) k, upper(coalesce(office_state, '')) st, office_county raw,
           row_number() over (partition by lower(office_county), upper(coalesce(office_state, '')) order by count(*) desc, office_county) rn
      from offices where office_county is not null group by lower(office_county), upper(coalesce(office_state, '')), office_county
  )
  select 'office', 'county', g.k, g.st, d.raw || case when g.st <> '' then ', ' || g.st else '' end, g.n
    from grp g join disp d on d.k = g.k and d.st = g.st and d.rn = 1;
  insert into location_options (scope, field, key, state, value, agent_count)
  select 'office', 'state', lower(upper(office_state)), '', upper(office_state), count(*)::int from offices where office_state is not null group by upper(office_state);

  -- brand / office-name options ordered by agent reach (A2)
  insert into location_options (scope, field, key, state, value, agent_count, variants)
  with disp as (
    select lower(brand) k, brand raw, count(*) c, row_number() over (partition by lower(brand) order by count(*) desc, brand) rn
      from agents where brand is not null group by lower(brand), brand
  ), grp as (
    select lower(brand) k, count(distinct id)::int n, count(distinct brand)::int variants from agents where brand is not null group by 1
  )
  select 'agent', 'brand', g.k, '', d.raw, g.n, g.variants from grp g join disp d on d.k = g.k and d.rn = 1;

  insert into location_options (scope, field, key, state, value, agent_count, variants)
  with disp as (
    select lower(office_name) k, office_name raw, row_number() over (partition by lower(office_name) order by count(*) desc, office_name) rn
      from agents where office_name is not null group by lower(office_name), office_name
  ), grp as (
    select lower(office_name) k, count(distinct id)::int n, count(distinct office_name)::int variants from agents where office_name is not null group by 1
  )
  select 'agent', 'office', g.k, '', d.raw, g.n, g.variants from grp g join disp d on d.k = g.k and d.rn = 1;
end;
$$;
-- Supabase DEFAULT-grants execute on new functions to anon/authenticated (the 0033 lesson) —
-- revoke explicitly; only server-side pool calls may run the truncate+rebuild.
revoke execute on function fn_refresh_location_options(boolean) from public, anon, authenticated;
select fn_refresh_location_options(true);

-- ======================= fn_search_options v2 =======================
drop function if exists fn_search_options(text, text, text);
create or replace function fn_search_options(p_type text, p_q text default '', p_field text default null, p_scope text default 'agent')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    select coalesce(jsonb_agg(distinct title), '[]'::jsonb) into res from agents where title is not null;
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
$$;
grant execute on function fn_search_options(text, text, text, text) to anon, authenticated;
