-- 0078: schedule the per-MLS location options rebuild (A15).
--
-- fn_refresh_location_options_mls_tick() carries its own hourly debounce and only rebuilds when
-- the data is actually dirty, so firing it every 10 minutes is cheap — most ticks do nothing.
-- It is deliberately a SEPARATE job from the 5-minute location-options tick: that one rebuilds
-- the unscoped table on a 10-minute debounce, while this rebuild costs ~2m19s and must not run
-- at that cadence or it would compete with the scraper for the instance's 2 parallel workers.
--
-- Idempotent: cron.schedule() upserts by job name, so re-applying this migration is safe.

SELECT cron.schedule(
  'location-options-mls',
  '*/10 * * * *',
  $$select fn_refresh_location_options_mls_tick()$$
);
