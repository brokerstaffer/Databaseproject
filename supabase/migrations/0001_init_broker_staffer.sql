-- 0001_init_broker_staffer.sql
-- Broker Staffer — Agent & Office database (Courted replica). Initial schema.
-- Idempotent (safe to re-run): IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS.

create extension if not exists pg_trgm;

-- =========================================================
-- Auth / roles
-- =========================================================
create table if not exists user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'viewer',   -- owner | admin | manager | viewer
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create or replace function get_user_role()
returns text language sql stable security definer set search_path = public as $$
  select role from user_profiles where id = auth.uid();
$$;

-- =========================================================
-- Offices
-- =========================================================
create table if not exists offices (
  id            uuid primary key default gen_random_uuid(),
  brand         text,
  office_name   text,
  office_city   text,
  office_zip    text,
  office_county text,
  office_state  text,
  sales_volume     numeric,   -- aggregate (from data files, not summed)
  list_side_dollar numeric,
  buy_side_dollar  numeric,
  units            integer,
  agent_count   integer not null default 0,
  sources       text[] not null default '{}',
  match_key     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- =========================================================
-- Agents (target ~2.5M rows)
-- =========================================================
create table if not exists agents (
  id            uuid primary key default gen_random_uuid(),
  -- identity
  full_name       text,
  first_name      text,
  last_name       text,
  license_number  text,
  preferred_email text,
  preferred_phone text,
  -- affiliation
  brand        text,
  office_name  text,
  office_id    uuid references offices(id) on delete set null,
  -- tenure
  est_time_in_industry_months integer,
  est_time_in_industry_raw    text,
  est_time_at_office_months   integer,
  avg_time_at_office_months   integer,
  -- locations (as captured)
  home_city            text,
  home_zip             text,
  office_city          text,
  office_zip           text,
  most_transacted_city text,
  -- locations (derived from zip / "City, ST")
  home_county     text,
  home_state      text,
  office_county   text,
  office_state    text,
  transacted_state text,
  -- primary (Courted) metrics, denormalized for fast filtering
  sales_volume        numeric,
  pct_change          numeric,
  buy_side_dollar     numeric,
  list_side_dollar    numeric,
  approx_gci          numeric,
  avg_sale_price      numeric,
  closed_transactions integer,
  units               integer,
  buy_side_count      integer,
  list_side_count     integer,
  closed_rentals      integer,
  avg_rental_price    numeric,
  -- provenance / matching
  sources          text[] not null default '{}',  -- {courted,zillow,realtor}
  source_ids       jsonb  not null default '{}'::jsonb,
  match_key        text,
  match_confidence text   not null default 'high', -- high | low
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- =========================================================
-- MLS (Courted only) + per-source metrics + junctions
-- =========================================================
create table if not exists mls (
  id    uuid primary key default gen_random_uuid(),
  code  text unique,
  name  text,
  state text,
  created_at timestamptz not null default now()
);

create table if not exists agent_mls (
  agent_id      uuid not null references agents(id) on delete cascade,
  mls_id        uuid not null references mls(id) on delete cascade,
  mls_member_id text,                              -- the agent's "MLS ID"
  primary key (agent_id, mls_id)
);

create table if not exists office_mls (
  office_id uuid not null references offices(id) on delete cascade,
  mls_id    uuid not null references mls(id) on delete cascade,
  primary key (office_id, mls_id)
);

create table if not exists agent_source_stats (
  agent_id uuid not null references agents(id) on delete cascade,
  source   text not null,                          -- courted | zillow | realtor
  sales_volume        numeric,
  pct_change          numeric,
  buy_side_dollar     numeric,
  list_side_dollar    numeric,
  approx_gci          numeric,
  avg_sale_price      numeric,
  closed_transactions integer,
  units               integer,
  buy_side_count      integer,
  list_side_count     integer,
  closed_rentals      integer,
  avg_rental_price    numeric,
  scraped_at timestamptz,
  primary key (agent_id, source)
);

-- =========================================================
-- Reference + app tables
-- =========================================================
create table if not exists zip_codes (
  zip    text primary key,
  city   text,
  county text,
  state  text
);

create table if not exists saved_lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null,
  mode        text not null default 'agent',          -- agent | office
  source_mode text not null default 'courted',        -- courted | zillow_realtor
  filters     jsonb not null default '{}'::jsonb,
  is_shared   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists clients (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  clay_webhook_url  text,
  bison_account_ref text,
  created_at        timestamptz not null default now()
);

create table if not exists client_mls (
  client_name text not null,
  mls_id      uuid not null references mls(id) on delete cascade,
  source      text not null default 'seed',          -- seed | list
  primary key (client_name, mls_id)
);

create table if not exists export_jobs (
  id              uuid primary key default gen_random_uuid(),
  requested_by    uuid references auth.users(id),
  filters_used    jsonb,
  selected_ids    uuid[],
  column_selection text[],
  row_count       integer,
  status          text not null default 'pending',
  file_path       text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create table if not exists filter_options_cache (
  col_name   text primary key,
  options    text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- =========================================================
-- updated_at trigger
-- =========================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create or replace trigger trg_agents_updated  before update on agents      for each row execute function set_updated_at();
create or replace trigger trg_offices_updated before update on offices     for each row execute function set_updated_at();
create or replace trigger trg_lists_updated   before update on saved_lists for each row execute function set_updated_at();

-- =========================================================
-- Indexes
-- =========================================================
-- agents: location triplet (city/zip/county/state x office/home/transacted)
create index if not exists idx_agents_office_state     on agents(office_state);
create index if not exists idx_agents_home_state       on agents(home_state);
create index if not exists idx_agents_transacted_state on agents(transacted_state);
create index if not exists idx_agents_office_city      on agents(office_city);
create index if not exists idx_agents_home_city        on agents(home_city);
create index if not exists idx_agents_transacted_city  on agents(most_transacted_city);
create index if not exists idx_agents_office_county    on agents(office_county);
create index if not exists idx_agents_home_county      on agents(home_county);
create index if not exists idx_agents_office_zip       on agents(office_zip);
create index if not exists idx_agents_home_zip         on agents(home_zip);
-- affiliation
create index if not exists idx_agents_brand       on agents(brand);
create index if not exists idx_agents_office_name on agents(office_name);
create index if not exists idx_agents_office_id   on agents(office_id);
-- metrics (range filters)
create index if not exists idx_agents_sales_volume on agents(sales_volume);
create index if not exists idx_agents_list_side    on agents(list_side_dollar);
create index if not exists idx_agents_buy_side     on agents(buy_side_dollar);
create index if not exists idx_agents_units        on agents(units);
create index if not exists idx_agents_closed_tx    on agents(closed_transactions);
-- typeahead (trigram)
create index if not exists idx_agents_full_name_trgm   on agents using gin (full_name gin_trgm_ops);
create index if not exists idx_agents_license_trgm     on agents using gin (license_number gin_trgm_ops);
create index if not exists idx_agents_brand_trgm       on agents using gin (brand gin_trgm_ops);
create index if not exists idx_agents_office_name_trgm on agents using gin (office_name gin_trgm_ops);
create index if not exists idx_agents_sources          on agents using gin (sources);
create index if not exists idx_agents_created_at       on agents(created_at desc);
-- junctions / offices / mls
create index if not exists idx_agent_mls_mls    on agent_mls(mls_id);
create index if not exists idx_office_mls_mls   on office_mls(mls_id);
create index if not exists idx_offices_brand    on offices(brand);
create index if not exists idx_offices_state    on offices(office_state);
create index if not exists idx_offices_name_trgm on offices using gin (office_name gin_trgm_ops);
create index if not exists idx_mls_name_trgm    on mls using gin (name gin_trgm_ops);

-- =========================================================
-- Row Level Security
-- service_role bypasses RLS; SECURITY DEFINER RPCs (added later) bypass it too.
-- Authenticated users get read on core data; writes happen via service_role / RPCs.
-- =========================================================
alter table user_profiles      enable row level security;
alter table agents             enable row level security;
alter table offices            enable row level security;
alter table mls                enable row level security;
alter table agent_mls          enable row level security;
alter table office_mls         enable row level security;
alter table agent_source_stats enable row level security;
alter table zip_codes          enable row level security;
alter table saved_lists        enable row level security;
alter table clients            enable row level security;
alter table client_mls         enable row level security;
alter table export_jobs        enable row level security;
alter table filter_options_cache enable row level security;

drop policy if exists "read agents"        on agents;             create policy "read agents"        on agents             for select to authenticated using (true);
drop policy if exists "read offices"       on offices;            create policy "read offices"       on offices            for select to authenticated using (true);
drop policy if exists "read mls"           on mls;                create policy "read mls"           on mls                for select to authenticated using (true);
drop policy if exists "read agent_mls"     on agent_mls;          create policy "read agent_mls"     on agent_mls          for select to authenticated using (true);
drop policy if exists "read office_mls"    on office_mls;         create policy "read office_mls"    on office_mls         for select to authenticated using (true);
drop policy if exists "read stats"         on agent_source_stats; create policy "read stats"         on agent_source_stats for select to authenticated using (true);
drop policy if exists "read zips"          on zip_codes;          create policy "read zips"          on zip_codes          for select to authenticated using (true);
drop policy if exists "read clients"       on clients;            create policy "read clients"       on clients            for select to authenticated using (true);
drop policy if exists "read client_mls"    on client_mls;         create policy "read client_mls"    on client_mls         for select to authenticated using (true);
drop policy if exists "read filter_cache"  on filter_options_cache; create policy "read filter_cache" on filter_options_cache for select to authenticated using (true);

drop policy if exists "self profile" on user_profiles;
create policy "self profile" on user_profiles for select to authenticated using (id = auth.uid() or get_user_role() in ('owner','admin'));

drop policy if exists "lists read"   on saved_lists; create policy "lists read"   on saved_lists for select to authenticated using (user_id = auth.uid() or is_shared);
drop policy if exists "lists insert" on saved_lists; create policy "lists insert" on saved_lists for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "lists update" on saved_lists; create policy "lists update" on saved_lists for update to authenticated using (user_id = auth.uid());
drop policy if exists "lists delete" on saved_lists; create policy "lists delete" on saved_lists for delete to authenticated using (user_id = auth.uid());

drop policy if exists "exports read"   on export_jobs; create policy "exports read"   on export_jobs for select to authenticated using (requested_by = auth.uid() or get_user_role() in ('owner','admin'));
drop policy if exists "exports insert" on export_jobs; create policy "exports insert" on export_jobs for insert to authenticated with check (requested_by = auth.uid());
