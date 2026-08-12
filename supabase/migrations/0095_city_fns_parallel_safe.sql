-- 0095: let scans that touch the city helpers use more than one core.
--
-- fn_city_embedded_state and fn_city_match_key were declared IMMUTABLE but PARALLEL UNSAFE.
-- A parallel-unsafe function anywhere in a query forbids Postgres from using parallel workers
-- for that ENTIRE query -- and both appear in almost every location predicate the filter engine
-- emits, so those scans were pinned to a single core no matter how many were available.
--
-- Both are pure SQL: a regex match against a fixed list of state codes, and a normalising key.
-- No writes, no temp tables, no sequences, no session state. They were always parallel safe;
-- the declaration simply never said so (PARALLEL UNSAFE is the default when unspecified).
--
-- This mattered little on Medium, which allowed one worker per query. On XL
-- (max_parallel_workers_per_gather = 2) it is worth having. Measured after the upgrade:
--
--     excluding 7 cities   998 -> 767 ms
--     location view      3,411 -> 3,432 ms   (unchanged -- dominated by count(distinct))
--     MLS view           4,596 -> 4,544 ms   (unchanged)
--     MLS-only search    2,221 -> 2,209 ms   (unchanged)
--
-- Only the exclude path gains, because the others spend their time in aggregation rather than
-- in these functions. Kept because it is a real gain with nothing traded away.
--
-- Volatility is untouched, so the expression indexes built on fn_city_match_key
-- (idx_agents_office_city_key and friends) remain valid -- verified after applying.
-- Reversible: ALTER FUNCTION ... PARALLEL UNSAFE.

ALTER FUNCTION public.fn_city_embedded_state(text) PARALLEL SAFE;
ALTER FUNCTION public.fn_city_match_key(text) PARALLEL SAFE;
