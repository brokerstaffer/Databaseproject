-- 0009_admin.sql
-- Admin page support: API keys (scraper auth for /api/ingest/agents) + audit/activity log.
-- Accessed only via the pg pool in token/role-authed API routes, so RLS is enabled
-- with no policies (the pool's postgres role bypasses RLS; the anon/auth client is denied).

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  key          text not null unique,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);
alter table api_keys enable row level security;

-- audit_logs: what logAudit() writes to (used by invite / role change / delete / reset /
-- ingest / clay send / api key actions). Feeds the Admin > Activity tab.
create table if not exists audit_logs (
  id           uuid primary key default gen_random_uuid(),
  action       text not null,
  performed_by text,
  details      text,
  created_at   timestamptz not null default now()
);
alter table audit_logs enable row level security;
create index if not exists idx_audit_logs_created on audit_logs (created_at desc);

drop table if exists activity_log;
