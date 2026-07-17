-- 0032_geo_inference.sql
-- Fill missing state/county from evidence when the source data has only a city (e.g. the
-- client-sheet imports: "Cincinnati" with no zip/state). Two lookup tables are built from
-- ALL available evidence — the zip_codes reference plus our own agents' zip-derived rows:
--   city_state_geo: city -> state, ONLY when >=95% of evidence points at one state
--                   ("Cincinnati" -> OH; "Springfield" spans 22 states -> excluded)
--   city_geo:       (city, state) -> dominant county, ONLY when >=90% of evidence agrees
-- The derive triggers use them as a FALLBACK: a real zip always wins; inference only fills
-- what would otherwise stay null. Triggers are renamed *_zgeo_* so they fire AFTER the city
-- normalization trigger (BEFORE-triggers run alphabetically) and look up normalized cities.
-- Idempotent.

set statement_timeout = 600000;

-- ======================= evidence tables =======================
create table if not exists city_geo (
  city_lower text not null,
  state text not null,
  county text,
  evidence int not null,
  primary key (city_lower, state)
);
create table if not exists city_state_geo (
  city_lower text primary key,
  state text not null,
  evidence int not null
);
grant select on city_geo, city_state_geo to anon, authenticated;

create or replace function fn_refresh_city_geo() returns void
language sql security definer set search_path = public as $$
  truncate city_geo, city_state_geo;

  with ev as (
    select lower(trim(city)) as city_lower, upper(trim(state)) as state, county, count(*)::int as cnt
      from zip_codes
     where nullif(trim(city), '') is not null and nullif(trim(state), '') is not null and county is not null
     group by 1, 2, 3
    union all
    select lower(office_city), upper(office_state), office_county, count(*)::int
      from agents where office_city is not null and office_state is not null and office_county is not null
     group by 1, 2, 3
    union all
    select lower(home_city), upper(home_state), home_county, count(*)::int
      from agents where home_city is not null and home_state is not null and home_county is not null
     group by 1, 2, 3
    union all
    select lower(most_transacted_city), upper(transacted_state), most_transacted_county, count(*)::int
      from agents where most_transacted_city is not null and transacted_state is not null and most_transacted_county is not null
     group by 1, 2, 3
  ), agg as (
    select city_lower, state, county, sum(cnt)::int cnt from ev where state ~ '^[A-Z]{2}$' group by 1, 2, 3
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

  with by_state as (
    select city_lower, state, sum(evidence)::int cnt from city_geo group by 1, 2
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

-- ======================= derive triggers (zip wins; inference fills the rest) =======================
create or replace function fn_agent_geo_derive() returns trigger
language plpgsql set search_path = public as $$
declare c text;
begin
  -- OFFICE
  if new.office_state is null and new.office_city is not null then
    select state into new.office_state from city_state_geo where city_lower = lower(new.office_city);
  end if;
  c := null;
  if new.office_zip is not null then
    select county into c from zip_codes where zip = left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if c is null and new.office_city is not null and new.office_state is not null then
    select county into c from city_geo where city_lower = lower(new.office_city) and state = upper(new.office_state);
  end if;
  new.office_county := c;

  -- HOME
  if new.home_state is null and new.home_city is not null then
    select state into new.home_state from city_state_geo where city_lower = lower(new.home_city);
  end if;
  c := null;
  if new.home_zip is not null then
    select county into c from zip_codes where zip = left(regexp_replace(new.home_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if c is null and new.home_city is not null and new.home_state is not null then
    select county into c from city_geo where city_lower = lower(new.home_city) and state = upper(new.home_state);
  end if;
  new.home_county := c;

  -- MOST TRANSACTED
  if new.transacted_state is null and new.most_transacted_city is not null then
    select state into new.transacted_state from city_state_geo where city_lower = lower(new.most_transacted_city);
  end if;
  c := null;
  if new.most_transacted_zip is not null then
    select county into c from zip_codes where zip = left(regexp_replace(new.most_transacted_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if c is null and new.most_transacted_city is not null and new.transacted_state is not null then
    select county into c from city_geo where city_lower = lower(new.most_transacted_city) and state = upper(new.transacted_state);
  end if;
  new.most_transacted_county := c;

  return new;
end;
$$;

create or replace function fn_office_geo_derive() returns trigger
language plpgsql set search_path = public as $$
declare c text;
begin
  if new.office_state is null and new.office_city is not null then
    select state into new.office_state from city_state_geo where city_lower = lower(new.office_city);
  end if;
  c := null;
  if new.office_zip is not null then
    select county into c from zip_codes where zip = left(regexp_replace(new.office_zip, '[^0-9]', '', 'g'), 5) limit 1;
  end if;
  if c is null and new.office_city is not null and new.office_state is not null then
    select county into c from city_geo where city_lower = lower(new.office_city) and state = upper(new.office_state);
  end if;
  new.office_county := c;
  return new;
end;
$$;

-- rename so these fire AFTER trg_agent_norm_cities / trg_office_norm_city (alphabetical)
drop trigger if exists trg_agent_counties on agents;
drop trigger if exists trg_agent_zgeo_derive on agents;
create trigger trg_agent_zgeo_derive
  before insert or update of office_city, office_state, office_zip, home_city, home_state, home_zip,
                             most_transacted_city, transacted_state, most_transacted_zip on agents
  for each row execute function fn_agent_geo_derive();

drop trigger if exists trg_office_county on offices;
drop trigger if exists trg_office_zgeo_derive on offices;
create trigger trg_office_zgeo_derive
  before insert or update of office_city, office_state, office_zip on offices
  for each row execute function fn_office_geo_derive();

-- ======================= backfill =======================
-- (a) offices know their location best: propagate to their agents' office_* blanks
update agents a
   set office_city = coalesce(a.office_city, o.office_city),
       office_state = coalesce(a.office_state, o.office_state),
       office_zip = coalesce(a.office_zip, o.office_zip)
  from offices o
 where o.id = a.office_id
   and ((a.office_city is null and o.office_city is not null)
     or (a.office_state is null and o.office_state is not null)
     or (a.office_zip is null and o.office_zip is not null));

-- (b) fill states from unambiguous cities
update agents set office_state = g.state from city_state_geo g
 where office_state is null and office_city is not null and g.city_lower = lower(office_city);
update agents set home_state = g.state from city_state_geo g
 where home_state is null and home_city is not null and g.city_lower = lower(home_city);
update agents set transacted_state = g.state from city_state_geo g
 where transacted_state is null and most_transacted_city is not null and g.city_lower = lower(most_transacted_city);
update offices set office_state = g.state from city_state_geo g
 where office_state is null and office_city is not null and g.city_lower = lower(office_city);

-- (c) fill counties from (city, state) where no zip could
update agents set office_county = g.county from city_geo g
 where office_county is null and office_city is not null and office_state is not null
   and g.city_lower = lower(office_city) and g.state = upper(office_state) and g.county is not null;
update agents set home_county = g.county from city_geo g
 where home_county is null and home_city is not null and home_state is not null
   and g.city_lower = lower(home_city) and g.state = upper(home_state) and g.county is not null;
update agents set most_transacted_county = g.county from city_geo g
 where most_transacted_county is null and most_transacted_city is not null and transacted_state is not null
   and g.city_lower = lower(most_transacted_city) and g.state = upper(transacted_state) and g.county is not null;
update offices set office_county = g.county from city_geo g
 where office_county is null and office_city is not null and office_state is not null
   and g.city_lower = lower(office_city) and g.state = upper(office_state) and g.county is not null;
