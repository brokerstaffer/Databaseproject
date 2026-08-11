-- 0073: make the DEFAULT sort (sales volume, highest first) an index scan instead of a full sort.
--
-- Symptom: the unfiltered Agent Search screen — the landing view, and the state you return to
-- after "Clear all" — took ~2 s in the data query alone, with no filters applied at all.
--
-- Cause: fn_agent_order emits the default order as
--     sales_volume desc nulls last
-- but the only index was btree (sales_volume), which in Postgres means ASC NULLS LAST. Scanning
-- that index backwards yields DESC NULLS FIRST — a different ordering — so the planner could not
-- use it and fell back to reading every row and sorting:
--     Parallel Seq Scan on agents (actual rows=1130973)
--     Sort Key: sales_volume DESC NULLS LAST  ->  top-N heapsort
-- Reading 1.13M rows to return 20.
--
-- A matching (sales_volume DESC NULLS LAST) index lets LIMIT 20 walk the first 20 index entries
-- and stop. The existing ASC index is kept: fn_agent_order also emits "asc nulls last" when the
-- user flips the sort direction, and that form needs the ASC index.
--
-- Behaviour is unchanged: same rows, same order, found without the sort.
--
-- APPLY NOTE: same as 0071/0072 — CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, so do NOT run this through scripts/apply-sql.mjs. Apply via psql, one statement at a time.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_sales_volume_desc
  ON public.agents (sales_volume DESC NULLS LAST);

ANALYZE public.agents;
