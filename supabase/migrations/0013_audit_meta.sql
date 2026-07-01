-- 0013_audit_meta.sql
-- Add a structured `meta` field to audit_logs so a Clay send can record which specific agents
-- failed (+ the client/campaign/columns/source needed to re-send them). This powers the
-- "Retry failed" button in Admin > Activity — a retry re-sends ONLY the failed agents.
alter table audit_logs add column if not exists meta jsonb;
