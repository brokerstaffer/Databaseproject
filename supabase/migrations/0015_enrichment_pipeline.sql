-- 0015_enrichment_pipeline.sql
-- In-house email-enrichment pipeline (replaces the Clay table). A "Send to campaign" creates
-- one enrichment_batches row + one enrichment_items row per agent. A dedicated Railway worker
-- (scripts/enrich-worker.mjs) claims pending items, runs the enrichment steps (replicated from
-- the client's Clay table), caches the result on agents (pay to enrich once, reuse forever),
-- then pushes finished leads into the chosen EmailBison campaign.
--
-- Item status machine (worker-enforced):
--   pending -> enriching -> enriched | no_email
--   enriched -> pushing  -> sent | failed
--   (failed items are retryable from the activity log; a retry re-queues ONLY failed items)

create table if not exists enrichment_batches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  orch_client_id uuid,                     -- optional: orch_clients.id when sent via the client filter
  campaign_id text,                        -- EmailBison numeric campaign id (e.g. "73"); null = enrich only
  campaign_name text,
  status text not null default 'queued',   -- queued | running | done | cancelled
  total int not null default 0,
  enriched int not null default 0,         -- got an email (cached or fresh)
  no_email int not null default 0,         -- pipeline exhausted, no usable email
  sent int not null default 0,             -- pushed into the Bison campaign
  failed int not null default 0,           -- terminal errors (after retries)
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists enrichment_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references enrichment_batches(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  status text not null default 'pending',
  attempts int not null default 0,
  error text,
  email text,                              -- result for this run
  email_status text,                       -- verified | catch_all | unknown
  provider text,                           -- which provider/step found the email
  step_log jsonb not null default '[]'::jsonb, -- [{step, ok, ms, note}] per-step trace for debugging
  bison_lead_id text,
  claimed_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (batch_id, agent_id)
);

-- worker claim scan + batch progress reads
create index if not exists idx_enrich_items_status on enrichment_items (status, created_at);
create index if not exists idx_enrich_items_batch on enrichment_items (batch_id, status);

-- Permanent per-agent enrichment cache: an agent is only ever paid-enriched once; any later
-- send (any client/campaign) reuses the stored result and goes straight to the push stage.
alter table agents
  add column if not exists enriched_email text,
  add column if not exists enriched_email_status text,  -- verified | catch_all | not_found
  add column if not exists enriched_provider text,
  add column if not exists enriched_at timestamptz;

-- App users read batches/items through server APIs (pg pool). Lock the tables down under RLS;
-- the pool role (postgres) bypasses it, browser roles get read-only on batches for progress UIs.
alter table enrichment_batches enable row level security;
alter table enrichment_items enable row level security;
drop policy if exists enrichment_batches_read on enrichment_batches;
create policy enrichment_batches_read on enrichment_batches for select to authenticated using (true);
drop policy if exists enrichment_items_read on enrichment_items;
create policy enrichment_items_read on enrichment_items for select to authenticated using (true);
