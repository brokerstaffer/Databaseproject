-- 0018_batch_filters.sql
-- Store the search filters a campaign send was created from, so the Export page can show
-- exactly what selection produced each batch.
alter table enrichment_batches add column if not exists filters jsonb;
