-- 0005_title_and_numeric_counts.sql
-- Adds the agent "title" (role) column for include/exclude filtering, and widens
-- count columns to numeric (Courted shows fractional units, e.g. 5,276.5). Idempotent.

-- Title: Salesperson | Team Leader | Managing Broker (derived from Courted flags at import)
alter table agents add column if not exists title text;
create index if not exists idx_agents_title on agents(title);

-- Count columns -> numeric (avoid truncating .5)
alter table agents alter column closed_transactions type numeric using closed_transactions::numeric;
alter table agents alter column units               type numeric using units::numeric;
alter table agents alter column buy_side_count      type numeric using buy_side_count::numeric;
alter table agents alter column list_side_count     type numeric using list_side_count::numeric;
alter table agents alter column closed_rentals      type numeric using closed_rentals::numeric;

alter table agent_source_stats alter column closed_transactions type numeric using closed_transactions::numeric;
alter table agent_source_stats alter column units               type numeric using units::numeric;
alter table agent_source_stats alter column buy_side_count      type numeric using buy_side_count::numeric;
alter table agent_source_stats alter column list_side_count     type numeric using list_side_count::numeric;
alter table agent_source_stats alter column closed_rentals      type numeric using closed_rentals::numeric;
