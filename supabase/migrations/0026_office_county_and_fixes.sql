-- 0026_office_county_and_fixes.sql
-- Second-pass review fixes:
--  (1) offices.office_county was never populated, so the office-mode County filter always
--      returned 0 — derive it from office_zip via zip_codes (trigger + backfill).
--  (2) the agents county trigger kept a STALE county when a refresh cleared a zip to NULL —
--      county now clears with the zip.
--  (3) fn_filter_ids office sort allowlist matched fewer columns than fn_filter_search —
--      aligned (list/buy side dollar).

-- ---- offices: derive county from office_zip ----
create or replace function fn_office_derive_county() returns trigger
language plpgsql as $$
begin
  if new.office_zip is null then
    new.office_county := null;
  else
    select county into new.office_county from zip_codes
     where zip = left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_office_county on offices;
create trigger trg_office_county before insert or update of office_zip on offices
  for each row execute function fn_office_derive_county();

create index if not exists idx_offices_county on offices (office_county);

-- ---- agents: clear county when the zip clears ----
create or replace function fn_agent_derive_counties() returns trigger
language plpgsql as $$
begin
  if new.office_zip is null then
    new.office_county := null;
  else
    select county into new.office_county from zip_codes where zip = left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if new.home_zip is null then
    new.home_county := null;
  else
    select county into new.home_county from zip_codes where zip = left(regexp_replace(new.home_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if new.most_transacted_zip is null then
    new.most_transacted_county := null;
  else
    select county into new.most_transacted_county from zip_codes where zip = left(regexp_replace(new.most_transacted_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  return new;
end;
$$;

-- ---- fn_filter_ids: office sort parity with fn_filter_search ----
create or replace function fn_filter_ids(
  p_mode text default 'agent', p_source text default 'courted', p_filters jsonb default '{}'::jsonb,
  p_sort_by text default 'sales_volume', p_sort_dir text default 'desc', p_limit int default 100000, p_offset int default 0
) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v_where text; v_order text; v_ids uuid[];
begin
  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
    v_order := format('%I %s nulls last',
      case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count'
        when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' else 'sales_volume' end,
      case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
  else
    v_where := fn_agent_where(p_source, p_filters);
    v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);
  end if;
  execute format('select array_agg(id) from (select id from %I where %s order by %s limit %s offset %s) t',
    case when p_mode = 'office' then 'offices' else 'agents' end, v_where, v_order, p_limit, p_offset) into v_ids;
  return coalesce(v_ids, '{}');
end;
$$;
grant execute on function fn_filter_ids(text, text, jsonb, text, text, int, int) to anon, authenticated;
