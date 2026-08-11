-- 0071: index the stored *_city_key columns the location filter actually reads.
--
-- fn_agent_where emits the city condition against the STORED columns:
--     office_city_key = ANY('{miami}'::text[])
-- but the only indexes covering them were on the EXPRESSION fn_city_match_key(office_city).
-- Same value, different form — the planner cannot use an expression index for a bare column
-- reference, so every city search fell back to a full sequential scan of ~1.1M rows. Worse,
-- fn_filter_search scans TWICE per search (once for count(*), once for the page of data).
--
-- Measured before this migration (production, warm cache):
--     one city filter, appliesTo all three kinds ......... 13.8 - 15.3 s
--     the same predicate written as the indexed expression .... 0.245 s
--     EXPLAIN: "Seq Scan on agents ... Rows Removed by Filter: 1098592"
--
-- The expression indexes are NOT dropped: they are still used (~6.5k-7.4k scans each) by
-- fn_rebuild_location_options / fn_refresh_city_geo, which aggregate on fn_city_match_key(...).
-- These new indexes sit alongside them and serve the search path only.
--
-- Behaviour is unchanged: indexes alter how rows are found, never which rows are returned.
--
-- APPLY NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this file
-- must NOT go through scripts/apply-sql.mjs (node-pg wraps a multi-statement query in an
-- implicit transaction). Run each statement separately with psql, which autocommits:
--     psql "$DATABASE_URL" -c "<one statement>"
-- If a CONCURRENTLY build is interrupted it leaves an INVALID index behind; check with
--     select indexrelid::regclass, indisvalid from pg_index where not indisvalid;
-- and DROP INDEX any invalid one before retrying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_office_city_key_stored
  ON public.agents (office_city_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_home_city_key_stored
  ON public.agents (home_city_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_transacted_city_key_stored
  ON public.agents (most_transacted_city_key);

ANALYZE public.agents;
