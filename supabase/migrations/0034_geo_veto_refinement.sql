-- 0034_geo_veto_refinement.sql
-- 0033's multi-state veto was binary: ANY second state in zip_codes vetoed the city — so
-- Cincinnati (OH, 21 ref zips) was vetoed by Cincinnati IA (1 ref zip, pop ~400) and the
-- sheet-imported Cincinnati agents lost their OH fill again. Refine: a city is only vetoed
-- when its TOP state holds <95% of its zips in the reference — real ambiguity (Portland
-- ~74% OR, Charleston, Peoria, Springfield) stays vetoed; landslide cases map. The 95%
-- agent-evidence bar still applies on top. Then re-run the fill-blanks backfill so rows
-- reverted under the blunt veto are re-filled. Idempotent.

set statement_timeout = 600000;

create or replace function fn_refresh_city_geo() returns void
language sql security definer set search_path = public as $$
  truncate city_geo, city_state_geo;

  with ev as (
    -- zip-backed evidence ONLY (see 0033): reference zips + agent rows whose county came
    -- from a real zip; inference-filled rows can never feed back into the thresholds.
    select lower(trim(city)) as city_lower, upper(trim(state)) as state, county, count(*)::int as cnt
      from zip_codes
     where nullif(trim(city), '') is not null and nullif(trim(state), '') is not null and county is not null
     group by 1, 2, 3
    union all
    select lower(office_city), upper(office_state), office_county, count(*)::int
      from agents where office_city is not null and office_state is not null and office_county is not null and office_zip is not null
     group by 1, 2, 3
    union all
    select lower(home_city), upper(home_state), home_county, count(*)::int
      from agents where home_city is not null and home_state is not null and home_county is not null and home_zip is not null
     group by 1, 2, 3
    union all
    select lower(most_transacted_city), upper(transacted_state), most_transacted_county, count(*)::int
      from agents where most_transacted_city is not null and transacted_state is not null and most_transacted_county is not null and most_transacted_zip is not null
     group by 1, 2, 3
  ), agg as (
    select city_lower, state, county, sum(cnt)::int cnt from ev
     where state ~ '^[A-Z]{2}$'
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
    -- ambiguity per the national reference: share of the city's reference zips held by its
    -- top state. Cities absent from the reference get NULL (no veto — agent evidence rules).
    select city_lower, max(share) as top_share from (
      select lower(trim(city)) city_lower, upper(trim(state)) state,
             count(*)::numeric / sum(count(*)) over (partition by lower(trim(city))) as share
        from zip_codes
       where nullif(trim(city), '') is not null and nullif(trim(state), '') is not null
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

-- re-run the fill-blanks backfill (rows reverted under the blunt veto get re-filled)
update agents set office_state = g.state from city_state_geo g
 where office_state is null and office_city is not null and g.city_lower = lower(office_city);
update agents set home_state = g.state from city_state_geo g
 where home_state is null and home_city is not null and g.city_lower = lower(home_city);
update agents set transacted_state = g.state from city_state_geo g
 where transacted_state is null and most_transacted_city is not null and g.city_lower = lower(most_transacted_city);
update offices set office_state = g.state from city_state_geo g
 where office_state is null and office_city is not null and g.city_lower = lower(office_city);

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
