-- 0087: DESC NULLS LAST indexes for the agent table's sortable money columns.
--
-- The table sorts numeric columns descending by default. Postgres cannot serve
-- "order by col desc nulls last" from a plain ascending btree: scanning an ASC index backwards
-- yields DESC NULLS *FIRST*, which is a different ordering, so the planner sorts the whole
-- table instead. That is why sales_volume (which got its DESC index in 0073) was the only fast
-- sort on the page and every other column cost 0.9-1.5 s.
--
-- Measured on an unfiltered page, ordering a narrow (id, sort key) set as of 0086:
--     sort with no matching index    540.1 ms
--     sort with DESC NULLS LAST        1.9 ms
--
-- These are ADDITIVE. Nothing was dropped -- the existing ascending indexes stay exactly as
-- they are and continue to serve ascending sorts and range filters.
--
-- Built with CREATE INDEX CONCURRENTLY so the scraper and enrich-worker keep writing during
-- the build (a plain CREATE INDEX takes a lock that blocks writes for the duration). Note that
-- CONCURRENTLY cannot run inside a transaction block, so these were applied directly rather
-- than through scripts/apply-sql.mjs, which wraps a file in one transaction. They are recorded
-- here so the schema is reproducible; IF NOT EXISTS makes re-running safe.
--
-- Each one came out at 24-25 MB, against 69-72 MB for the equivalent ascending index on the
-- same data -- the old ones carry years of page-split bloat, these are freshly packed. Total
-- added: 171 MB (1,759 MB -> 1,930 MB of indexes on agents).
--
-- Deliberately NOT indexed: the text sort columns (full_name, office_name, brand, title) and
-- the remaining low-traffic numerics. They now cost ~700-890 ms via the narrow-sort path in
-- 0086, down from ~1.0-1.25 s, and indexing all of them would add several hundred MB more to
-- an instance whose heap plus indexes already exceed its cache. Worth revisiting only if
-- someone actually sorts by them often.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_units_desc
  ON public.agents (units DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_closed_transactions_desc
  ON public.agents (closed_transactions DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_approx_gci_desc
  ON public.agents (approx_gci DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_avg_sale_price_desc
  ON public.agents (avg_sale_price DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_total_sales_all_time_desc
  ON public.agents (total_sales_all_time DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_buy_side_dollar_desc
  ON public.agents (buy_side_dollar DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_list_side_dollar_desc
  ON public.agents (list_side_dollar DESC NULLS LAST);

-- Zero-row guard index from 0085, recorded here for completeness (created at the same time).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_full_name_null
  ON public.agents (id) WHERE full_name IS NULL;
