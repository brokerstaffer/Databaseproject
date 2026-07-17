-- 0033_geo_inference_hardening.sql
-- Fixes from the adversarial verification of 0032's geo inference:
--   (1) HIGH  fn_refresh_city_geo was PostgREST-callable with the anon key (SECURITY DEFINER +
--             default EXECUTE grant): anyone could TRUNCATE+rebuild the evidence tables in a
--             loop, blocking every agents/offices write behind the ACCESS EXCLUSIVE lock.
--   (2) HIGH  circular evidence: the refresh counted agents' county columns as evidence
--             without distinguishing zip-derived from INFERRED values, so each refresh would
--             ratchet our own guesses into unbeatable majorities. Evidence is now zip-backed
--             rows only.
--   (3) MED   state inference ignored the row's OWN zip (1,266 rows got a city-inferred state
--             contradicting their zip's state). Zip now resolves state first, and conflicting
--             inference-pattern rows are repaired to their zip's state.
--   (4) MED   genuinely multi-state city names (portland, peoria, charleston) were hard-mapped
--             to our dataset's dominant metro. city_state_geo now VETOES any city that
--             zip_codes itself places in 2+ states; fills made under vetoed/removed mappings
--             are reverted.
--   (5) LOW   placeholder cities ('Other', 'Unknown', address strings) were inference keys —
--             denylisted.
--   (6) LOW/MED  trigger semantics: per-kind change detection (an office_zip update can no
--             longer wipe an inferred home_county), and a city CHANGE re-infers that kind's
--             state — but only when it can positively resolve (zip or unambiguous city); it
--             never nulls a state it can't replace.
-- Idempotent (the vetoed-fill repair only reverts rows stamped by the 0032/0033 backfills).

set statement_timeout = 600000;

-- ======================= (1) lock down the refresh =======================
revoke execute on function fn_refresh_city_geo() from public, anon, authenticated;

-- ======================= (2)(4)(5) clean evidence rebuild =======================
create or replace function fn_refresh_city_geo() returns void
language sql security definer set search_path = public as $$
  truncate city_geo, city_state_geo;

  with ev as (
    -- zip-backed evidence ONLY: the zip_codes reference plus agent rows whose county came
    -- from a real zip. Inference-filled rows (no zip) are excluded so our own guesses can
    -- never feed back into the thresholds.
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
       and city_lower !~ '[0-9]'                            -- address strings / zip-as-city
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

  with multi_state_in_ref as (
    -- zip_codes is the national arbiter of ambiguity: if IT places a city in 2+ states, no
    -- amount of our own regional data may hard-map that city to one state.
    select lower(trim(city)) city_lower
      from zip_codes where nullif(trim(city), '') is not null and nullif(trim(state), '') is not null
     group by 1 having count(distinct upper(trim(state))) >= 2
  ), by_state as (
    select g.city_lower, g.state, sum(g.evidence)::int cnt
      from city_geo g
     where not exists (select 1 from multi_state_in_ref m where m.city_lower = g.city_lower)
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

-- keep the pre-rebuild mappings to identify fills that lose their justification
create temp table old_csg as select * from city_state_geo;
create temp table old_cg as select * from city_geo where county is not null;

select fn_refresh_city_geo();

-- ======================= (4)(5) revert fills under removed mappings =======================
-- Rows stamped today by the 0032 backfill (or post-0032 trigger) under a city->state mapping
-- that the clean rebuild no longer contains: state (and its inferred county) go back to null.
update agents a set office_state = null, office_county = null
 from old_csg o
 where a.office_zip is null and a.office_city is not null
   and o.city_lower = lower(a.office_city) and a.office_state = o.state
   and not exists (select 1 from city_state_geo n where n.city_lower = o.city_lower)
   and a.updated_at::date = current_date;
update agents a set home_state = null, home_county = null
 from old_csg o
 where a.home_zip is null and a.home_city is not null
   and o.city_lower = lower(a.home_city) and a.home_state = o.state
   and not exists (select 1 from city_state_geo n where n.city_lower = o.city_lower)
   and a.updated_at::date = current_date;
update agents a set transacted_state = null, most_transacted_county = null
 from old_csg o
 where a.most_transacted_zip is null and a.most_transacted_city is not null
   and o.city_lower = lower(a.most_transacted_city) and a.transacted_state = o.state
   and not exists (select 1 from city_state_geo n where n.city_lower = o.city_lower)
   and a.updated_at::date = current_date;
update offices f set office_state = null, office_county = null
 from old_csg o
 where f.office_zip is null and f.office_city is not null
   and o.city_lower = lower(f.office_city) and f.office_state = o.state
   and not exists (select 1 from city_state_geo n where n.city_lower = o.city_lower)
   and f.updated_at::date = current_date;

-- county fills whose (city,state) mapping lost its county in the clean rebuild
update agents a set office_county = null
 from old_cg o
 where a.office_zip is null and a.office_city is not null and a.office_state is not null
   and o.city_lower = lower(a.office_city) and o.state = upper(a.office_state) and a.office_county = o.county
   and not exists (select 1 from city_geo n where n.city_lower = o.city_lower and n.state = o.state and n.county = o.county)
   and a.updated_at::date = current_date;
update agents a set home_county = null
 from old_cg o
 where a.home_zip is null and a.home_city is not null and a.home_state is not null
   and o.city_lower = lower(a.home_city) and o.state = upper(a.home_state) and a.home_county = o.county
   and not exists (select 1 from city_geo n where n.city_lower = o.city_lower and n.state = o.state and n.county = o.county)
   and a.updated_at::date = current_date;
update agents a set most_transacted_county = null
 from old_cg o
 where a.most_transacted_zip is null and a.most_transacted_city is not null and a.transacted_state is not null
   and o.city_lower = lower(a.most_transacted_city) and o.state = upper(a.transacted_state) and a.most_transacted_county = o.county
   and not exists (select 1 from city_geo n where n.city_lower = o.city_lower and n.state = o.state and n.county = o.county)
   and a.updated_at::date = current_date;

-- ======================= (3) zip beats city: repair contradicting states =======================
-- Rows whose state matches the citywide inference while their own zip says otherwise get the
-- zip's state (and their county already comes from the zip, so the row becomes consistent).
update agents a set office_state = z.state
  from zip_codes z
 where a.office_zip is not null
   and z.zip = left(regexp_replace(a.office_zip, '[^0-9]', '', 'g'), 5)
   and a.office_state is not null and upper(a.office_state) <> upper(z.state)
   and exists (select 1 from old_csg o where o.city_lower = lower(a.office_city) and o.state = upper(a.office_state));
update agents a set home_state = z.state
  from zip_codes z
 where a.home_zip is not null
   and z.zip = left(regexp_replace(a.home_zip, '[^0-9]', '', 'g'), 5)
   and a.home_state is not null and upper(a.home_state) <> upper(z.state)
   and exists (select 1 from old_csg o where o.city_lower = lower(a.home_city) and o.state = upper(a.home_state));
update agents a set transacted_state = z.state
  from zip_codes z
 where a.most_transacted_zip is not null
   and z.zip = left(regexp_replace(a.most_transacted_zip, '[^0-9]', '', 'g'), 5)
   and a.transacted_state is not null and upper(a.transacted_state) <> upper(z.state)
   and exists (select 1 from old_csg o where o.city_lower = lower(a.most_transacted_city) and o.state = upper(a.transacted_state));

-- ======================= (3)(6) trigger v2 =======================
-- Per-kind change detection; zip resolves state before city inference; a city CHANGE re-infers
-- state but never nulls one it can't replace; counties only recompute for the kind that changed.
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
        select state into s from city_state_geo where city_lower = lower(new.office_city);
      end if;
      if s is not null then new.office_state := s; end if;   -- assign only when resolved; never null
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.office_city is not null and new.office_state is not null then
      select county into c from city_geo where city_lower = lower(new.office_city) and state = upper(new.office_state);
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
        select state into s from city_state_geo where city_lower = lower(new.home_city);
      end if;
      if s is not null then new.home_state := s; end if;   -- assign only when resolved; never null
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.home_city is not null and new.home_state is not null then
      select county into c from city_geo where city_lower = lower(new.home_city) and state = upper(new.home_state);
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
        select state into s from city_state_geo where city_lower = lower(new.most_transacted_city);
      end if;
      if s is not null then new.transacted_state := s; end if;   -- assign only when resolved; never null
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.most_transacted_city is not null and new.transacted_state is not null then
      select county into c from city_geo where city_lower = lower(new.most_transacted_city) and state = upper(new.transacted_state);
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
        select state into s from city_state_geo where city_lower = lower(new.office_city);
      end if;
      if s is not null then new.office_state := s; end if;   -- assign only when resolved; never null
    end if;
    c := null;
    if z is not null then select county into c from zip_codes where zip = z limit 1; end if;
    if c is null and new.office_city is not null and new.office_state is not null then
      select county into c from city_geo where city_lower = lower(new.office_city) and state = upper(new.office_state);
    end if;
    new.office_county := c;
  end if;
  return new;
end;
$$;

drop table old_csg;
drop table old_cg;
