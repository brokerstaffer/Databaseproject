-- 0017_enrichment_skipped.sql
-- Client-scope dedup: before uploading to EmailBison, the worker checks whether the lead is
-- already in ANY campaign belonging to the same client (campaign naming convention:
-- "Client Name + Sender + Market" — prefix before the first " + " = client). Such items are
-- marked status='skipped' (terminal) instead of being re-uploaded; batches count them here.
alter table enrichment_batches add column if not exists skipped int not null default 0;
