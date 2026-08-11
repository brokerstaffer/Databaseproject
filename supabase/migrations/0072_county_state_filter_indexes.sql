-- 0072: index the county / state location filters the way fn_agent_where actually queries them.
--
-- Companion to 0071 (which fixed the city level). The remaining two geography levels were still
-- doing full scans, because the engine wraps the column in a case-folding call:
--     lower(office_county) = ANY('{miami-dade}'::text[])
--     upper(office_state)  = ANY('{FL}'::text[])
-- The existing indexes are on the BARE columns, so the planner could only do an Index ONLY Scan
-- across the entire index and filter afterwards — never a seek.
--
-- Measured after 0071, before this migration (production, end-to-end through fn_filter_search):
--     county filter ....... 5.0 - 7.0 s
--     state filter ........ 4.3 - 7.8 s
--     zip filter (control, already correctly indexed) .... 0.094 s
--
-- Why not just drop the case-folding from fn_agent_where instead?
--   * state: it IS very nearly redundant — only 2 of 1,091,237 office_state values are not
--     already uppercase, and home/transacted are 100% clean. But "nearly" is not "always", and
--     dropping upper() would silently change which rows match for those 2 (and for anything the
--     scraper sends in mixed case later). Indexing costs nothing in correctness; changing the
--     predicate does.
--   * county: genuinely required — 1,078,725 values are title-cased ("Miami-Dade"), so lower()
--     is doing real work and cannot be removed at all.
--
-- Behaviour is unchanged: indexes alter how rows are found, never which rows are returned.
--
-- APPLY NOTE: same as 0071 — CREATE INDEX CONCURRENTLY cannot run inside a transaction block,
-- so do NOT run this through scripts/apply-sql.mjs. Apply each statement separately via psql.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_office_county_lower
  ON public.agents (lower(office_county));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_home_county_lower
  ON public.agents (lower(home_county));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_transacted_county_lower
  ON public.agents (lower(most_transacted_county));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_office_state_upper
  ON public.agents (upper(office_state));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_home_state_upper
  ON public.agents (upper(home_state));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_transacted_state_upper
  ON public.agents (upper(transacted_state));

ANALYZE public.agents;
