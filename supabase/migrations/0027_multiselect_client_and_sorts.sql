-- 0027_multiselect_client_and_sorts.sql
-- Three product changes:
--   (1) CLIENT filter is multi-select. fn_agent_where / fn_office_where now read an array
--       p_filters->'orchClientIds' (union: agents built for ANY of the chosen clients), with a
--       fallback to the legacy scalar p_filters->>'orchClientId' so old saved views still work.
--   (2) Sortable MLS affiliation + LinkedIn columns. LinkedIn is a scalar column; MLS affiliation
--       is a junction, so sort on fn_agent_primary_mls(id) = the agent's alphabetically-first MLS
--       code (matches the value the table displays, which joins the codes).
--   (3) Multi-campaign sends: enrichment_batches.campaign_ids holds every chosen EmailBison
--       campaign (campaign_id stays = the first one, for the existing push/progress guards).
-- Idempotent (create or replace / add column if not exists).

-- ======================= MLS sort key =======================
-- Alphabetically-first MLS code for an agent (null if unaffiliated). Encapsulated so it can be
-- referenced as a bare `fn_agent_primary_mls(id)` in the ORDER BY of BOTH fn_filter_search
-- (from agents a) and fn_filter_ids (from agents) — at ORDER BY scope `id` is unambiguous.
create or replace function fn_agent_primary_mls(p_agent_id uuid) returns text
language sql stable set search_path = public as $$
  select min(m.code) from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = p_agent_id;
$$;
grant execute on function fn_agent_primary_mls(uuid) to anon, authenticated;

-- ======================= AGENT ORDER (adds mls + linkedin_url) =======================
create or replace function fn_agent_order(p_filters jsonb, p_sort_by text, p_sort_dir text) returns text
language sql immutable as $$
  select case when coalesce(p_filters->>'nameQuery', '') <> ''
    then format('(full_name ilike %L) desc, ', '%' || (p_filters->>'nameQuery') || '%') else '' end
  || case p_sort_by
       -- MLS affiliation: sort on the derived primary code (function, not a column ident)
       when 'mls' then format('fn_agent_primary_mls(id) %s nulls last',
         case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end)
       else format('%I %s nulls last',
         case p_sort_by
           when 'full_name' then 'full_name' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
           when 'closed_transactions' then 'closed_transactions' when 'est_time_in_industry_months' then 'est_time_in_industry_months'
           when 'license_number' then 'license_number' when 'office_name' then 'office_name'
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
           else 'sales_volume' end,
         case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end)
     end;
$$;
grant execute on function fn_agent_order(jsonb, text, text) to anon, authenticated;

-- ======================= AGENT WHERE (multi-client) =======================
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

  -- ORCH CLIENT(S): include (only these clients' leads) or exclude (everyone but them).
  -- Multi-select via orchClientIds (array); falls back to the legacy scalar orchClientId.
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

  -- MISSING CONTACT: agents missing the selected contact info (both selected = missing both).
  f := p_filters->'missingContact';
  if f is not null then
    if (f->>'email') = 'true' then parts := parts || '(preferred_email is null or preferred_email = '''')'::text; end if;
    if (f->>'phone') = 'true' then parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text; end if;
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$$;

-- ======================= OFFICE WHERE (multi-client) =======================
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

  -- OFFICE AGENT COUNT (range on the stored agent_count)
  f := p_filters->'agentCount';
  if f is not null then c := fn_range_cond('agent_count', f); if c is not null then parts := parts || c; end if; end if;

  -- ORCH CLIENT(S): offices holding at least one of these clients' leads (include/exclude).
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

-- ======================= Multi-campaign sends =======================
-- Every EmailBison campaign a batch targets. campaign_id stays = the first one so the existing
-- push-stage claim + progress guards (which key off campaign_id is not null) keep working.
alter table enrichment_batches add column if not exists campaign_ids text[];
