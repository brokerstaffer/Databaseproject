-- 0039_email_match_indexes.sql
-- The Bison lead sync matches campaign emails to agents by lower(preferred_email) /
-- lower(enriched_email); without these, every synced campaign seq-scans 770k+ agents twice.
-- (Applied CONCURRENTLY outside a transaction by the migration runner.)
create index if not exists idx_agents_pref_email_lower on agents (lower(preferred_email));
create index if not exists idx_agents_enr_email_lower on agents (lower(enriched_email));
