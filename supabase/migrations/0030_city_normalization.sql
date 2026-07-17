-- 0030_city_normalization.sql
-- City values arrive from the scrapers as raw strings ("los angeles", "Los Angeles (City)",
-- "Atlanta, GA, 30318", "Aberdeen Twp.", "Beverly Hills,"), so the location dropdown showed
-- every variant as a separate option and exact-match filtering missed agents stored under a
-- different variant. Normalize at ingest (same pattern as the county derivation):
--   fn_norm_city: trim -> strip trailing "(...)" -> strip trailing zip -> strip trailing
--   punctuation -> strip trailing ", ST" / " ST" state suffixes -> collapse whitespace ->
--   initcap. Surveyed live data first: of 11,412 distinct values, initcap changes 1,313 and
--   the sample is overwhelmingly typo-fixes; no McKinney-style names in the data.
-- Filter side: fn_agent_where / fn_office_where normalize incoming city values too, so saved
-- views that stored a dirty variant ("los angeles") keep matching after the backfill.
-- Idempotent.

set statement_timeout = 600000;  -- headroom for the one-time backfill

-- ======================= normalizer =======================
create or replace function fn_norm_city(p text) returns text
language sql immutable as $$
  select nullif(initcap(lower(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      trim(coalesce(p, '')),
      '\s*\([^)]*\)\s*$', ''),                                   -- "(City)" parentheticals
      '[\s,]+\d{5}(-\d{4})?\s*$', ''),                            -- trailing zip codes
      '[\s,;:]+$', ''),                                           -- trailing commas/colons
      '(?i),\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MD|ME|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR)\s*$', ''),  -- ", ST" any case
      '\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MD|ME|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR)\s*$', ''),      -- " ST" upper-case only ("La Porte" is safe)
      '[\s.,;:]+$', ''),                                          -- "Twp." style trailing periods
      '\s+', ' ', 'g')                                            -- collapse whitespace
  )), '')
$$;
grant execute on function fn_norm_city(text) to anon, authenticated;

-- ======================= ingest triggers =======================
create or replace function fn_agent_norm_cities() returns trigger
language plpgsql set search_path = public as $$
begin
  new.office_city := fn_norm_city(new.office_city);
  new.home_city := fn_norm_city(new.home_city);
  new.most_transacted_city := fn_norm_city(new.most_transacted_city);
  return new;
end $$;
drop trigger if exists trg_agent_norm_cities on agents;
create trigger trg_agent_norm_cities before insert or update on agents
  for each row execute function fn_agent_norm_cities();

create or replace function fn_office_norm_city() returns trigger
language plpgsql set search_path = public as $$
begin
  new.office_city := fn_norm_city(new.office_city);
  return new;
end $$;
drop trigger if exists trg_office_norm_city on offices;
create trigger trg_office_norm_city before insert or update on offices
  for each row execute function fn_office_norm_city();

-- ======================= filter side: normalize incoming city values =======================
-- fn_agent_where / fn_office_where re-created from 0027 with ONE change each: when the
-- location field is 'city', the selected values are passed through fn_norm_city so dirty
-- values saved before this migration (and any future unnormalized input) still match.
create or replace function fn_agent_where(p_source text, p_filters jsonb) returns text
language plpgsql stable set search_path = public as $$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; side text; c text;
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
    arr := array(select jsonb_array_elements_text(f->'values'));
    if field = 'city' then
      arr := array(select distinct fn_norm_city(u) from unnest(arr) u where fn_norm_city(u) is not null);
    end if;
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    kconds := '{}';
    foreach kind in array kinds loop
      col := case kind
        when 'office' then 'office_' || field
        when 'home' then 'home_' || field
        when 'transacted' then case field
          when 'city' then 'most_transacted_city'
          when 'zip' then 'most_transacted_zip'
          when 'county' then 'most_transacted_county'
          when 'state' then 'transacted_state' else null end
        else null end;
      if col is not null then kconds := kconds || format('%I = ANY(%L::text[])', col, arr); end if;
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

  f := p_filters->'missingContact';
  if f is not null then
    if (f->>'email') = 'true' then parts := parts || '(preferred_email is null or preferred_email = '''')'::text; end if;
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
  f jsonb; sub jsonb; arr text[]; col text; field text; side text; c text;
  v_client_ids text[];
begin
  f := p_filters->'location';
  if f is not null and jsonb_array_length(coalesce(f->'values', '[]'::jsonb)) > 0 then
    field := coalesce(f->>'field', 'city');
    arr := array(select jsonb_array_elements_text(f->'values'));
    if field = 'city' then
      arr := array(select distinct fn_norm_city(u) from unnest(arr) u where fn_norm_city(u) is not null);
    end if;
    col := case field when 'state' then 'office_state' else 'office_' || field end;
    parts := parts || format('%I = ANY(%L::text[])', col, arr);
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

-- ======================= one-time backfill =======================
update agents
   set office_city = fn_norm_city(office_city),
       home_city = fn_norm_city(home_city),
       most_transacted_city = fn_norm_city(most_transacted_city)
 where office_city is distinct from fn_norm_city(office_city)
    or home_city is distinct from fn_norm_city(home_city)
    or most_transacted_city is distinct from fn_norm_city(most_transacted_city);

update offices
   set office_city = fn_norm_city(office_city)
 where office_city is distinct from fn_norm_city(office_city);
