-- 0037_options_hardening.sql
-- Fixes from the adversarial verification of 0035/0036, plus a pre-existing hole the grant
-- sweep exposed:
--   (1) HIGH  lockdown: location_options(+meta), city_geo/city_state_geo/city_aliases AND the
--       orch_* tables (incl. orch_clients with portal tokens) were writable — and orch_*
--       readable — with the PUBLIC anon key via Supabase default grants + no RLS. All app
--       access goes through the server pool / SECURITY DEFINER functions, so anon and
--       authenticated lose every direct privilege on them.
--   (2) Embedded ", ST" states: fn_city_embedded_state() extracts a trailing state from raw
--       city strings. Options group by the EFFECTIVE state (column else embedded), the WHERE
--       state check matches it, and the geo triggers use it (zip > embedded > inference), so
--       'Columbia, SC'-style raw rows are reachable, deduped, and get their state derived.
--   (3) Bare (no-state) city options now carry the KEY-WIDE agent count — matching what
--       selecting them actually returns (legacy any-state semantics).
--   (4) Junk options excluded (denylist + 3+-digit runs); state filter compares upper();
--       legacy missingContact email semantics aligned with the new contact filter.
--   (5) Refresh: staged rebuild (heavy aggregation into a stage table; the visible table is
--       only locked for the short swap), dirty-tracking, and a pg_cron tick every 5 minutes
--       gives the debounce a trailing edge (final ingest chunks reach the dropdowns).
-- Idempotent.

set statement_timeout = 600000;

-- ======================= (1) lockdown =======================
revoke all on location_options, location_options_meta, city_geo, city_state_geo, city_aliases from public, anon, authenticated;
revoke all on orch_clients, orch_client_leads, orch_client_team, orch_connector_deliveries,
  orch_email_account, orch_email_replies, orch_introductions, orch_salespeople, orch_templates
  from public, anon, authenticated;

-- ======================= (2) embedded state =======================
create or replace function fn_city_embedded_state(p text) returns text
language sql immutable as $$
  select case when u = any(array['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','MD','ME','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR'])
         then u else null end
  from (select upper((regexp_match(coalesce(p, ''), ',\s*([A-Za-z]{2})\s*$'))[1]) u) s
$$;
grant execute on function fn_city_embedded_state(text) to anon, authenticated;

-- ======================= (5) staged refresh with dirty tracking =======================
alter table location_options_meta add column if not exists dirty_at timestamptz not null default 'epoch';

create unlogged table if not exists location_options_stage (like location_options including defaults);
revoke all on location_options_stage from public, anon, authenticated;

create or replace function fn_refresh_location_options(p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- every call marks the data dirty (callers invoke this after writing agents/offices)
  update location_options_meta set dirty_at = now() where id = 1;
  if not p_force and (select refreshed_at from location_options_meta where id = 1) > now() - interval '10 minutes' then
    return; -- debounced; the cron tick picks up the trailing edge
  end if;
  perform fn_rebuild_location_options();
end;
$$;
revoke execute on function fn_refresh_location_options(boolean) from public, anon, authenticated;

-- cron tick: rebuild only when data changed since the last rebuild and the debounce has aged out
create or replace function fn_refresh_location_options_tick() returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select refreshed_at, dirty_at into m from location_options_meta where id = 1;
  if m.dirty_at > m.refreshed_at and m.refreshed_at < now() - interval '10 minutes' then
    perform fn_rebuild_location_options();
  end if;
end;
$$;
revoke execute on function fn_refresh_location_options_tick() from public, anon, authenticated;

create or replace function fn_rebuild_location_options() returns void
language plpgsql security definer set search_path = public as $$
begin
  update location_options_meta set refreshed_at = now() where id = 1;
  truncate location_options_stage;

  -- agent-scope city: group by match key + EFFECTIVE state (column else embedded-in-string);
  -- display = most common raw variant with any embedded ", ST" stripped, then ", ST" appended.
  insert into location_options_stage (scope, field, key, state, value, agent_count, variants)
  with rows as (
    select id, office_city raw, coalesce(upper(office_state), fn_city_embedded_state(office_city), '') st from agents where office_city is not null
    union all select id, home_city, coalesce(upper(home_state), fn_city_embedded_state(home_city), '') from agents where home_city is not null
    union all select id, most_transacted_city, coalesce(upper(transacted_state), fn_city_embedded_state(most_transacted_city), '') from agents where most_transacted_city is not null
  ), keyed as (
    select id, raw, st, fn_city_match_key(raw) k from rows
     where fn_city_match_key(raw) is not null
       and fn_city_match_key(raw) !~ '\d{3,}'
       and fn_city_match_key(raw) not in ('other', 'unknown', 'null', 'n/a', 'na', 'none', 'city', 'test', 'tbd', 'various')
  ), grp as (
    select k, st, count(distinct id)::int agents, count(distinct raw)::int variants from keyed group by 1, 2
  ), keywide as (
    select k, count(distinct id)::int agents from keyed group by 1
  ), disp as (
    select k, st, trim(regexp_replace(raw, ',\s*[A-Za-z]{2}\s*$', '')) base,
           row_number() over (partition by k, st order by count(*) desc, raw) rn
      from keyed group by k, st, raw
  )
  select 'agent', 'city', g.k, g.st,
         d.base || case when g.st <> '' then ', ' || g.st else '' end,
         -- bare options match key-wide (legacy any-state semantics), so show the key-wide count
         case when g.st = '' then w.agents else g.agents end,
         g.variants
    from grp g
    join keywide w on w.k = g.k
    join disp d on d.k = g.k and d.st = g.st and d.rn = 1;

  -- agent-scope zip / county / state
  insert into location_options_stage (scope, field, key, state, value, agent_count)
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

  insert into location_options_stage (scope, field, key, state, value, agent_count)
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

  insert into location_options_stage (scope, field, key, state, value, agent_count)
  with rows as (
    select id, upper(office_state) v from agents where office_state is not null
    union all select id, upper(home_state) from agents where home_state is not null
    union all select id, upper(transacted_state) from agents where transacted_state is not null
  )
  select 'agent', 'state', lower(v), '', v, count(distinct id)::int from rows group by v;

  -- office scope
  insert into location_options_stage (scope, field, key, state, value, agent_count, variants)
  with keyed as (
    select id, office_city raw, coalesce(upper(office_state), fn_city_embedded_state(office_city), '') st, fn_city_match_key(office_city) k
      from offices
     where fn_city_match_key(office_city) is not null
       and fn_city_match_key(office_city) !~ '\d{3,}'
       and fn_city_match_key(office_city) not in ('other', 'unknown', 'null', 'n/a', 'na', 'none', 'city', 'test', 'tbd', 'various')
  ), grp as (
    select k, st, count(distinct id)::int n, count(distinct raw)::int variants from keyed group by 1, 2
  ), keywide as (
    select k, count(distinct id)::int n from keyed group by 1
  ), disp as (
    select k, st, trim(regexp_replace(raw, ',\s*[A-Za-z]{2}\s*$', '')) base,
           row_number() over (partition by k, st order by count(*) desc, raw) rn from keyed group by k, st, raw
  )
  select 'office', 'city', g.k, g.st, d.base || case when g.st <> '' then ', ' || g.st else '' end,
         case when g.st = '' then w.n else g.n end, g.variants
    from grp g join keywide w on w.k = g.k join disp d on d.k = g.k and d.st = g.st and d.rn = 1;

  insert into location_options_stage (scope, field, key, state, value, agent_count)
  with clean as (
    select office_zip v from offices where office_zip is not null and office_zip !~* '^\s*(n/?a?|none|null|-+)\s*$'
  ), grp as (
    select lower(v) k, count(*)::int n from clean group by 1
  ), disp as (
    select lower(v) k, v raw, row_number() over (partition by lower(v) order by count(*) desc, v) rn from clean group by lower(v), v
  )
  select 'office', 'zip', g.k, '', d.raw, g.n from grp g join disp d on d.k = g.k and d.rn = 1;

  insert into location_options_stage (scope, field, key, state, value, agent_count)
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

  insert into location_options_stage (scope, field, key, state, value, agent_count)
  select 'office', 'state', lower(upper(office_state)), '', upper(office_state), count(*)::int from offices where office_state is not null group by upper(office_state);

  -- brand / office-name (A2)
  insert into location_options_stage (scope, field, key, state, value, agent_count, variants)
  with disp as (
    select lower(brand) k, brand raw, row_number() over (partition by lower(brand) order by count(*) desc, brand) rn
      from agents where brand is not null group by lower(brand), brand
  ), grp as (
    select lower(brand) k, count(distinct id)::int n, count(distinct brand)::int variants from agents where brand is not null group by 1
  )
  select 'agent', 'brand', g.k, '', d.raw, g.n, g.variants from grp g join disp d on d.k = g.k and d.rn = 1;

  insert into location_options_stage (scope, field, key, state, value, agent_count, variants)
  with disp as (
    select lower(office_name) k, office_name raw, row_number() over (partition by lower(office_name) order by count(*) desc, office_name) rn
      from agents where office_name is not null group by lower(office_name), office_name
  ), grp as (
    select lower(office_name) k, count(distinct id)::int n, count(distinct office_name)::int variants from agents where office_name is not null group by 1
  )
  select 'agent', 'office', g.k, '', d.raw, g.n, g.variants from grp g join disp d on d.k = g.k and d.rn = 1;

  -- short swap: the visible table is locked only for this copy, not the aggregation above
  truncate location_options;
  insert into location_options select * from location_options_stage;
end;
$$;
revoke execute on function fn_rebuild_location_options() from public, anon, authenticated;

-- ======================= (2)(4) WHERE-builder v3.1 tweaks =======================
-- Patch the three spots (agent city branch state check, office city branch state check,
-- state-field equality) by re-creating both functions from the 0036 definitions with:
--   state check: coalesce(upper(statecol), fn_city_embedded_state(citycol)) = 'ST'
--   state field: upper(%I) = ANY(upper values)
--   legacy missingContact email: same coalesce(preferred, enriched) semantics as contact
-- (Full bodies below — identical to 0036 apart from those lines.)

-- ======================= (2) geo derive: zip > embedded > inference =======================
-- (fn_agent_geo_derive / fn_office_geo_derive re-created below with the embedded-state step.)
create or replace function fn_agent_where(p_source text, p_filters jsonb) returns text
language plpgsql stable set search_path = public as $$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; vconds text[]; side text; c text; v text; vst text; vbase text;
  citycol text; statecol text; ccol text;
  v_client_ids text[];
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
      parts := parts || format('id not in (select agent_id from orch_client_leads where client_id = any(%L::uuid[]) and agent_id is not null)', v_client_ids);
    else
      parts := parts || format('id in (select agent_id from orch_client_leads where client_id = any(%L::uuid[]) and agent_id is not null)', v_client_ids);
    end if;
  end if;

  -- LOCATION
  f := p_filters->'location';
  if f is not null and jsonb_array_length(coalesce(f->'values', '[]'::jsonb)) > 0 then
    field := coalesce(f->>'field', 'city');
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    kconds := '{}';
    foreach kind in array kinds loop
      citycol := case kind when 'office' then 'office_city' when 'home' then 'home_city' when 'transacted' then 'most_transacted_city' else null end;
      statecol := case kind when 'office' then 'office_state' when 'home' then 'home_state' when 'transacted' then 'transacted_state' else null end;
      ccol := case kind when 'office' then 'office_county' when 'home' then 'home_county' when 'transacted' then 'most_transacted_county' else null end;
      if citycol is null then continue; end if;

      if field = 'city' or field = 'county' then
        -- composite "Value, ST" (legacy bare values match without the state component)
        vconds := '{}';
        for v in select jsonb_array_elements_text(f->'values') loop
          vst := (regexp_match(v, ',\s*([A-Za-z]{2})\s*$'))[1];
          vbase := trim(regexp_replace(v, ',\s*[A-Za-z]{2}\s*$', ''));
          if field = 'city' then
            c := format('fn_city_match_key(%I) = fn_city_match_key(%L)', citycol, vbase);
          else
            c := format('lower(%I) = lower(%L)', ccol, vbase);
          end if;
          if vst is not null then
            if field = 'city' then
              c := '(' || c || format(' and coalesce(upper(%I), fn_city_embedded_state(%I)) = %L)', statecol, citycol, upper(vst));
            else
              c := '(' || c || format(' and upper(%I) = %L)', statecol, upper(vst));
            end if;
          end if;
          vconds := vconds || c;
        end loop;
        if array_length(vconds, 1) > 0 then kconds := kconds || ('(' || array_to_string(vconds, ' or ') || ')'); end if;
      else
        arr := array(select jsonb_array_elements_text(f->'values'));
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
    if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
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

  f := p_filters->'title';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('title = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(title is null or title <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
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
$$;

create or replace function fn_office_where(p_filters jsonb) returns text
language plpgsql stable set search_path = public as $$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; col text; field text; side text; c text; v text; vst text; vbase text;
  vconds text[];
  v_client_ids text[];
begin
  f := p_filters->'location';
  if f is not null and jsonb_array_length(coalesce(f->'values', '[]'::jsonb)) > 0 then
    field := coalesce(f->>'field', 'city');
    if field = 'city' or field = 'county' then
      vconds := '{}';
      for v in select jsonb_array_elements_text(f->'values') loop
        vst := (regexp_match(v, ',\s*([A-Za-z]{2})\s*$'))[1];
        vbase := trim(regexp_replace(v, ',\s*[A-Za-z]{2}\s*$', ''));
        if field = 'city' then
          c := format('fn_city_match_key(office_city) = fn_city_match_key(%L)', vbase);
        else
          c := format('lower(office_county) = lower(%L)', vbase);
        end if;
        if vst is not null then
          if field = 'city' then
            c := '(' || c || format(' and coalesce(upper(office_state), fn_city_embedded_state(office_city)) = %L)', upper(vst));
          else
            c := '(' || c || format(' and upper(office_state) = %L)', upper(vst));
          end if;
        end if;
        vconds := vconds || c;
      end loop;
      if array_length(vconds, 1) > 0 then parts := parts || ('(' || array_to_string(vconds, ' or ') || ')'); end if;
    else
      arr := array(select jsonb_array_elements_text(f->'values'));
      col := case field when 'state' then 'office_state' when 'zip' then 'office_zip' else 'office_city' end;
      if field = 'state' then
        parts := parts || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
      else
        parts := parts || format('%I = ANY(%L::text[])', col, arr);
      end if;
    end if;
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

  v_client_ids := case
    when jsonb_typeof(p_filters->'orchClientIds') = 'array' and jsonb_array_length(p_filters->'orchClientIds') > 0
      then array(select jsonb_array_elements_text(p_filters->'orchClientIds'))
    when coalesce(p_filters->>'orchClientId', '') <> ''
      then array[p_filters->>'orchClientId']
    else null end;
  if v_client_ids is not null then
    if coalesce(p_filters->>'orchClientMode', 'include') = 'exclude' then
      parts := parts || format('id not in (select a.office_id from orch_client_leads l join agents a on a.id = l.agent_id where l.client_id = any(%L::uuid[]) and a.office_id is not null)', v_client_ids);
    else
      parts := parts || format('id in (select a.office_id from orch_client_leads l join agents a on a.id = l.agent_id where l.client_id = any(%L::uuid[]) and a.office_id is not null)', v_client_ids);
    end if;
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$$;


grant execute on function fn_agent_where(text, jsonb) to anon, authenticated;
grant execute on function fn_office_where(jsonb) to anon, authenticated;

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
      if s is null then s := fn_city_embedded_state(new.office_city); end if;
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
      if s is null then s := fn_city_embedded_state(new.home_city); end if;
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
      if s is null then s := fn_city_embedded_state(new.most_transacted_city); end if;
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
      if s is null then s := fn_city_embedded_state(new.office_city); end if;
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


-- backfill states embedded in raw city strings (the 'Columbia, SC' class); the geo trigger
-- fires on the state update and derives the county
update agents set office_state = fn_city_embedded_state(office_city)
 where office_state is null and fn_city_embedded_state(office_city) is not null;
update agents set home_state = fn_city_embedded_state(home_city)
 where home_state is null and fn_city_embedded_state(home_city) is not null;
update agents set transacted_state = fn_city_embedded_state(most_transacted_city)
 where transacted_state is null and fn_city_embedded_state(most_transacted_city) is not null;
update offices set office_state = fn_city_embedded_state(office_city)
 where office_state is null and fn_city_embedded_state(office_city) is not null;

-- ======================= (5) trailing-edge cron =======================
do $cron$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'location-options-tick') then
      perform cron.schedule('location-options-tick', '*/5 * * * *', 'select fn_refresh_location_options_tick()');
    end if;
  end if;
end $cron$;

select fn_rebuild_location_options();
