-- 0076: denormalise the display name into location_options_mls + its rebuild function (A15).
--
-- WHY DENORMALISE. 0075 stored keys+counts only and joined location_options for the display
-- name at read time. Measured server-side (EXPLAIN ANALYZE, network excluded):
--     SOCAL / city ... 86.8 ms  -- 2,665 primary-key lookups into location_options
-- The lookups WERE the cost; the scan itself touches only a few thousand tiny rows. Carrying
-- the display name on the row removes the join entirely, so a read becomes one index scan.
-- The join now happens ONCE per rebuild (a single hash join over 127k rows) instead of on
-- every keystroke.
--
-- It also fixes a correctness gap. location_options only offers a bare (no-state) option when
-- a city has no state-qualified entries, and drops junk keys — so ~1% of per-MLS keys have no
-- row there and an INNER join silently dropped them:
--     city 523/46,440 (1.13%) | county 100/13,604 | zip 282/65,370 | state 0
-- Those are places that exist for a specific MLS but not as a global option. The rebuild now
-- LEFT JOINs and synthesises a display name when there is no match, so nothing disappears.
--
-- CADENCE. The rebuild costs ~74 s. location_options refreshes on a 10-minute debounce, which
-- is far too aggressive for this — 74 s of aggregation every 10 minutes would compete with the
-- scraper for the instance's 2 parallel workers. This gets its own hourly debounce, tracked by
-- location_options_meta.mls_refreshed_at. Location data changes slowly (an agent's city moves
-- rarely); an hour of staleness in a filter dropdown is invisible in practice.

ALTER TABLE public.location_options_mls        ADD COLUMN IF NOT EXISTS value text;
ALTER TABLE public.location_options_mls        ADD COLUMN IF NOT EXISTS variants integer NOT NULL DEFAULT 1;
ALTER TABLE public.location_options_mls_stage  ADD COLUMN IF NOT EXISTS value text;
ALTER TABLE public.location_options_mls_stage  ADD COLUMN IF NOT EXISTS variants integer NOT NULL DEFAULT 1;

ALTER TABLE public.location_options_meta ADD COLUMN IF NOT EXISTS mls_refreshed_at timestamptz NOT NULL DEFAULT '-infinity';

-- read path: filter by (mls_id, field), then order by reach. value is included so the common
-- query is satisfied without touching the heap.
CREATE INDEX IF NOT EXISTS idx_lom_read
  ON public.location_options_mls (mls_id, field, agent_count DESC) INCLUDE (value, variants);

CREATE OR REPLACE FUNCTION public.fn_rebuild_location_options_mls()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15min'
 SET work_mem TO '256MB'
AS $function$
begin
  truncate location_options_mls_stage;

  -- ONE pass over (agent x mls), expanding each agent into its 12 location tuples
  -- (4 levels x 3 kinds: office / home / most-transacted) via LATERAL VALUES. Three separate
  -- passes read the agents heap three times; this reads it once.
  --
  -- The distinct on (mls_id, field, key, state, id) is what makes an agent count ONCE per
  -- place: someone whose office AND home are both in Phoenix must not count twice there.
  insert into location_options_mls_stage (mls_id, field, key, state, agent_count, value, variants)
  with lat as (
    select am.mls_id, a.id, v.field, v.k, v.st
      from agents a
      join agent_mls am on am.agent_id = a.id
      cross join lateral (values
        ('city',   a.office_city_key,               coalesce(upper(a.office_state), fn_city_embedded_state(a.office_city), '')),
        ('city',   a.home_city_key,                 coalesce(upper(a.home_state), fn_city_embedded_state(a.home_city), '')),
        ('city',   a.most_transacted_city_key,      coalesce(upper(a.transacted_state), fn_city_embedded_state(a.most_transacted_city), '')),
        ('zip',    lower(a.office_zip),             ''),
        ('zip',    lower(a.home_zip),               ''),
        ('zip',    lower(a.most_transacted_zip),    ''),
        ('county', lower(a.office_county),          upper(coalesce(a.office_state, ''))),
        ('county', lower(a.home_county),            upper(coalesce(a.home_state, ''))),
        ('county', lower(a.most_transacted_county), upper(coalesce(a.transacted_state, ''))),
        ('state',  lower(a.office_state),           ''),
        ('state',  lower(a.home_state),             ''),
        ('state',  lower(a.transacted_state),       '')
      ) v(field, k, st)
     where v.k is not null and v.k <> ''
       -- same junk guard the unscoped rebuild applies to city keys
       and not (v.field = 'city' and (v.k ~ '\d{3,}'
                or v.k in ('other', 'unknown', 'null', 'n/a', 'na', 'none', 'city', 'test', 'tbd', 'various')))
  ),
  d as (select distinct mls_id, field, k, st, id from lat),
  g as (select mls_id, field, k, st, count(*)::int as n from d group by 1, 2, 3, 4)
  select g.mls_id, g.field, g.k, g.st, g.n,
         -- display name from the global options table when it has this place; otherwise
         -- synthesise one, so per-MLS-only places are never dropped
         coalesce(lo.value,
                  case g.field
                    when 'state' then upper(g.k)
                    when 'zip'   then g.k
                    else initcap(g.k) || case when g.st <> '' then ', ' || g.st else '' end
                  end),
         coalesce(lo.variants, 1)
    from g
    left join location_options lo
      on lo.scope = 'agent' and lo.field = g.field and lo.key = g.k and lo.state = g.st;

  -- short swap: the visible table is locked only for this copy, not the aggregation above
  truncate location_options_mls;
  insert into location_options_mls select * from location_options_mls_stage;

  update location_options_meta set mls_refreshed_at = now() where id = 1;
end;
$function$;

-- Hourly debounce, driven by the existing 5-minute cron tick (see fn_refresh_location_options_tick).
CREATE OR REPLACE FUNCTION public.fn_refresh_location_options_mls_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record;
begin
  select dirty_at, mls_refreshed_at into m from location_options_meta where id = 1;
  if m.dirty_at > m.mls_refreshed_at and m.mls_refreshed_at < now() - interval '1 hour' then
    perform fn_rebuild_location_options_mls();
  end if;
end;
$function$;
