-- 0008_bison_campaigns.sql
-- EmailBison: per-client API key + a cache of campaigns (refreshed by a 6h cron),
-- which feeds the campaign dropdown in the Export -> Send to Clay popup. Idempotent.

alter table clients add column if not exists bison_api_key text;
alter table clients add column if not exists bison_synced_at timestamptz;

create table if not exists bison_campaigns (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  bison_campaign_id text not null,
  name              text,
  status            text,
  raw               jsonb,
  fetched_at        timestamptz not null default now(),
  unique (client_id, bison_campaign_id)
);

create index if not exists idx_bison_campaigns_client on bison_campaigns(client_id);

alter table bison_campaigns enable row level security;
drop policy if exists "read bison_campaigns" on bison_campaigns;
create policy "read bison_campaigns" on bison_campaigns for select to authenticated using (true);

-- clients write policies (manage clients/webhooks/keys from the Webhooks page)
drop policy if exists "clients insert" on clients;
create policy "clients insert" on clients for insert to authenticated with check (get_user_role() in ('owner','admin','manager'));
drop policy if exists "clients update" on clients;
create policy "clients update" on clients for update to authenticated using (get_user_role() in ('owner','admin','manager'));
drop policy if exists "clients delete" on clients;
create policy "clients delete" on clients for delete to authenticated using (get_user_role() in ('owner','admin'));
