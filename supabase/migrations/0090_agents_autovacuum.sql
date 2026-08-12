-- 0090: vacuum `agents` on its own schedule instead of the cluster default.
--
-- The scraper and enrich-worker rewrite this table constantly -- 10,338,615 updates recorded
-- against 1,135,077 live rows. Every update leaves a dead row behind, and Postgres only
-- reclaims them when autovacuum runs.
--
-- The cluster default is autovacuum_vacuum_scale_factor = 0.2, i.e. wait until 20% of the
-- table is dead before cleaning:
--
--     trigger = 50 + 0.2 * 1,135,077 = 227,065 dead rows
--
-- So the table is allowed to carry a fifth of itself as garbage. Measured at the time of
-- writing: 152,144 dead rows, 11.8% of the table, 153 MB of the 1,293 MB heap -- and the last
-- autovacuum was 17 hours earlier. Every sequential scan reads that 153 MB for nothing, which
-- is paid directly by the location-exclude filter and any other full scan.
--
-- 0.02 brings the trigger to ~22,750 dead rows, so it vacuums roughly ten times more often and
-- keeps the dead fraction near 2% instead of drifting to 20%. Each run does correspondingly
-- less work. This is affordable here: disk I/O sits at ~1% and autovacuum is throttled by
-- autovacuum_vacuum_cost_delay (2 ms) so it yields rather than competing for CPU.
--
-- analyze gets the same treatment. Planner statistics on a table this volatile go stale between
-- the default analyze runs, and every filter in the app depends on row estimates being roughly
-- right -- a bad estimate is what turns an index scan into a sequential scan.
--
-- Table-scoped, so nothing else in the database changes. Fully reversible:
--     ALTER TABLE public.agents RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);

ALTER TABLE public.agents SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- offices takes the same shape of write load (4,599,379 updates, 169,751 live rows, 14.3% dead)
ALTER TABLE public.offices SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- saved_lists is tiny but rewritten constantly by the count refresh (9,485 updates on 16 rows,
-- 55.6% dead). The scale factor is meaningless at this size, so drive it off the flat threshold.
ALTER TABLE public.saved_lists SET (
  autovacuum_vacuum_scale_factor  = 0.0,
  autovacuum_vacuum_threshold     = 50,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold    = 50
);
