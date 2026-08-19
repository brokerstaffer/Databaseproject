-- 0112: stop the maintenance jobs from eating the database.
--
-- A client reported the app "running slowly, and after some time using it, it starts bugging out".
-- The search path was not the cause. Three pg_cron jobs were, measured over six hours of
-- cron.job_run_details:
--
--     job                                  cadence    per run   time spent
--     fn_refresh_location_options_tick     every 5m   107-109s  ~44 min of 360
--     fn_refresh_perf_views                every 15m   86-89s   ~35 min of 360
--     fn_refresh_location_options_mls_tick every 10m     ~9s     ~5 min of 360
--
-- That is roughly 23% of ALL WALL-CLOCK TIME with a heavy job running, and five of the location
-- ticks hit the 120 s statement ceiling and failed outright. A user query landing on top of one of
-- those is slow; one landing on a run that then times out is the "bugs out" -- it is the same
-- 120 s ceiling that produces an empty result rather than an error.
--
-- WHY THE CITY REBUILD RAN CONSTANTLY. fn_refresh_location_options() marks the data dirty on every
-- call, and both ingest routes (api/ingest/agents:41, api/import/csv:62) call it after writing.
-- The scraper feeds those continuously, so the dirty flag was never down and the 10-minute
-- debounce meant a 108-second rebuild roughly every 10 minutes, for ever.
--
-- The fix is cadence, not logic. These rebuild DROPDOWN OPTIONS -- the list of cities, counties and
-- states available to filter on -- and a genuinely new city only appears when an import brings one.
-- Nothing about the data justifies rebuilding that six times an hour.
--
-- The MLS twin already debounces at 1 hour (fn_refresh_location_options_mls_tick), which is why it
-- costs ~5 minutes per six hours instead of ~44. The city side was the outlier, not the pattern.
--
-- p_force => true still bypasses the debounce, so a rebuild can be demanded immediately after a
-- large import rather than waiting for the window.

-- 2 hours, not the MLS twin's 1 hour, because this rebuild is twelve times more expensive
-- (108 s against ~9 s). Expected cost: ~1.5% duty cycle, down from ~18%.
CREATE OR REPLACE FUNCTION public.fn_refresh_location_options_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record;
begin
  select refreshed_at, dirty_at into m from location_options_meta where id = 1;
  if m.dirty_at > m.refreshed_at and m.refreshed_at < now() - interval '2 hours' then
    perform fn_rebuild_location_options();
  end if;
end;
$function$;

-- The same window on the write side. Both guards must agree: this one debounces the caller, the
-- tick above picks up the trailing edge, and a shorter interval here would let an ingest burst
-- trigger the expensive rebuild directly.
CREATE OR REPLACE FUNCTION public.fn_refresh_location_options(p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- every call marks the data dirty (callers invoke this after writing agents/offices)
  update location_options_meta set dirty_at = now() where id = 1;
  if not p_force and (select refreshed_at from location_options_meta where id = 1) > now() - interval '2 hours' then
    return; -- debounced; the cron tick picks up the trailing edge
  end if;
  perform fn_rebuild_location_options();
end;
$function$;

-- fn_refresh_perf_views runs EIGHT full fn_filter_search aggregates over 1.13M agents (2 MLS +
-- 3 granularities x 2 kinds), which is why it takes 87 s. It was doing that every 15 minutes.
-- Hourly keeps the Location and MLS views fresh well inside any working session while cutting
-- this job's share from ~9.7% of wall-clock to ~2.4%.
--
-- Verified steady at 86-89 s per run across 15:00-18:45 on 2026-08-19, i.e. unchanged by the
-- Instantly union added in 0109 -- the cost is the aggregate itself, not the new join.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE command = 'select fn_refresh_perf_views()'),
  schedule => '7 * * * *'
);

-- Offset the ticks off the hour so the three jobs cannot pile onto the same minute as each other
-- or as the 6-hourly sequencer syncs, which is what turned a slow minute into a failed one.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE command = 'select fn_refresh_location_options_tick()'),
  schedule => '23 * * * *'
);
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE command = 'select fn_refresh_location_options_mls_tick()'),
  schedule => '41 * * * *'
);
