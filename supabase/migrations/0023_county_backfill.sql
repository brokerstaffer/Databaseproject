-- 0023_county_backfill.sql
-- County data was missing (zip_codes empty, county columns null) so the county location filter
-- returned nothing. zip_codes is now loaded (33k US zips); derive county/state from each agent's
-- office/home/most-transacted zip, and keep it current on every ingest via a trigger.

create index if not exists idx_zip_codes_zip on zip_codes (zip);
create index if not exists idx_agents_office_county on agents (office_county);
create index if not exists idx_agents_home_county on agents (home_county);
create index if not exists idx_agents_transacted_county on agents (most_transacted_county);

-- derive the three county columns from the matching zips (5-digit normalize)
create or replace function fn_agent_derive_counties() returns trigger
language plpgsql as $$
begin
  if new.office_zip is not null then
    select county into new.office_county from zip_codes where zip = left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if new.home_zip is not null then
    select county into new.home_county from zip_codes where zip = left(regexp_replace(new.home_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if new.most_transacted_zip is not null then
    select county into new.most_transacted_county from zip_codes where zip = left(regexp_replace(new.most_transacted_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_counties on agents;
create trigger trg_agent_counties before insert or update of office_zip, home_zip, most_transacted_zip on agents
  for each row execute function fn_agent_derive_counties();
