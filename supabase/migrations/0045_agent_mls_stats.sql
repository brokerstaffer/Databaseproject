-- 0045 (A5 phase 1 — stop the bleeding): per-(agent, MLS) production metrics.
-- Courted delivers one row per agent PER MLS, each with its own LTM production block;
-- the ingest previously kept only the last row per agent (upsert-agents.ts "last row
-- wins"), silently destroying every other MLS's numbers. This table stores them all;
-- the ingest upserts one row per (agent, mls) from now on. The denormalized agents.*
-- metric columns are NOT touched in this phase — they keep today's meaning until the
-- client signs off on the sum-across-MLSs rollup (A5 phase 3).
create table if not exists agent_mls_stats (
  agent_id uuid not null references agents(id) on delete cascade,
  mls_id uuid not null references mls(id) on delete cascade,
  sales_volume numeric,
  prev_sales_volume numeric,
  pct_change numeric,
  approx_gci numeric,
  avg_sale_price numeric,
  closed_transactions numeric,
  units numeric,
  buy_side_count numeric,
  list_side_count numeric,
  buy_side_dollar numeric,
  list_side_dollar numeric,
  avg_sale_price_buy_side numeric,
  avg_sale_price_list_side numeric,
  close_to_list_pct numeric,
  avg_days_on_market integer,
  closed_rentals numeric,
  avg_rental_price numeric,
  scraped_at timestamptz not null default now(),
  primary key (agent_id, mls_id)
);
create index if not exists idx_agent_mls_stats_mls on agent_mls_stats (mls_id);

-- 0033 lesson: Supabase default-grants to app roles; this table is service-path only.
revoke all on table agent_mls_stats from public, anon, authenticated;
