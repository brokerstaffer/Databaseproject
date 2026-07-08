-- 0016_enrichment_hardening.sql
-- Hardening from the adversarial review of the pipeline:
--   claim_token fences item writes so an overlapping worker (Railway deploys run old+new
--   side by side) can never clobber state that another worker has since reclaimed.
alter table enrichment_items add column if not exists claim_token uuid;
