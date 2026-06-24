-- 0002_courted_delta.sql
-- Schema delta to fit the real Courted agent CSV export. Idempotent.

-- --- New columns: agents -------------------------------------
alter table agents add column if not exists most_transacted_zip    text;
alter table agents add column if not exists most_transacted_county text;
alter table agents add column if not exists active_listings        integer;
alter table agents add column if not exists pending_listings       integer;
alter table agents add column if not exists home_address           text;

-- --- New columns: offices ------------------------------------
alter table offices add column if not exists office_address text;

-- --- New columns: agent_source_stats -------------------------
alter table agent_source_stats add column if not exists prev_sales_volume        numeric;
alter table agent_source_stats add column if not exists avg_sale_price_buy_side  numeric;
alter table agent_source_stats add column if not exists avg_sale_price_list_side numeric;
alter table agent_source_stats add column if not exists close_to_list_pct        numeric;
alter table agent_source_stats add column if not exists avg_days_on_market       integer;

-- --- Type changes: tenure integer -> numeric (decimal months) -
alter table agents alter column est_time_in_industry_months type numeric using est_time_in_industry_months::numeric;
alter table agents alter column est_time_at_office_months   type numeric using est_time_at_office_months::numeric;
alter table agents alter column avg_time_at_office_months   type numeric using avg_time_at_office_months::numeric;

-- --- Supporting indexes for new filterable columns -----------
create index if not exists idx_agents_transacted_zip   on agents(most_transacted_zip);
create index if not exists idx_agents_active_listings  on agents(active_listings);
create index if not exists idx_agents_pending_listings on agents(pending_listings);
