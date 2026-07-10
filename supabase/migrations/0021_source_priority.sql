-- 0021_source_priority.sql
-- "Send to campaign" source priority: which source's values win for the merged lead fields.
--   courted: courted -> zillow -> realtor      zillow: zillow -> courted -> realtor
--   realtor: realtor -> courted -> zillow
-- The worker resolves email/phone/city/office/profile/closed-transactions per this order at
-- push time (per-source values live in agents.source_ids and agent_source_stats).
alter table enrichment_batches add column if not exists source_priority text not null default 'courted';
