# Broker Staffer — Testing Checklist

App (live): **https://web-production-34f4a.up.railway.app**
Data: ~20 Courted sample agents + 13 offices + 1 MLS (full load pending the scraper handoff).

Legend: `[x]` verified · `[ ]` needs a manual/logged-in pass · `[blocked]` needs real data/integration

---

## ✅ Automated tests run (passing)

These were exercised directly against the **live** deployment + database.

### Search engine — 34/34
- [x] Unfiltered agent count (20) and total sales volume
- [x] Every filter returns correct counts: Location (city/zip/county/state × office/home/transacted), Sales volume (all/list/buy + buckets + min/max), Office Search (brand + office, **grouped include/exclude** — include+exclude sum to total), MLS (= junction count), Title, Closed units, Closed transactions, Est. time in industry, Approx. GCI, **Average sales price**, **Est. time in office**, **Average time at office**
- [x] **Source toggle**: All = 20, Courted = 20, Zillow/Realtor = 0 (honest empty)
- [x] **Office mode**: 13 offices, each with `agent_names` + office totals
- [x] Sorting (asc ≠ desc) and pagination (page 1 ≠ page 2)
- [x] Typeahead options for brand / office / mls / title / license / location
- [x] Combined filters narrow correctly
- [x] Each row carries `mls` + per-source `source_stats`

### Ingest webhook (end-to-end, live) — 12/12
- [x] Bad key → 401; valid env token / generated API key → accepted
- [x] Real Courted-column row (`Name`, `Office`, `State License`, `LTM Sales Volume`, `LTM Closed Units`, `Home City/State`, `Email`) → agent persisted with all fields correct
- [x] Office row auto-created for the agent
- [x] **Idempotent**: re-ingesting the same agent updates it (no duplicate) and updates changed metrics
- [x] Writes an `audit_logs` entry (shows on Admin → Activity + Import page)
- [x] **Column names must match the Courted CSV** (`Name`/`Office`/`LTM Sales Volume`, etc.) — the Admin → Data Webhook sample now shows the correct ones

### Bison sync endpoint (live) — verified
- [x] `POST /api/cron/bison-sync` with `x-cron-token` → 200; bad token → 401
- [x] Handles a client whose Bison key is invalid gracefully (per-client error, overall ok)

### Logged-in data layer under RLS — 11/11
- [x] Create + delete a user via the **real service_role** (confirms Admin → Users invite/delete works)
- [x] Sign-in; `fn_filter_search` + `fn_search_options` work for an authenticated user
- [x] Saved views: insert / read-own / delete under RLS (this was the read-bug fix)
- [x] Clients read under RLS; `fn_clients_for_mls` returns

---

## [ ] Needs a manual logged-in (browser) pass

The visual/interaction layer — quick click-through at the live URL:
- [ ] Login lands on **Agent Search**; top bar + sign-out; left nav highlights
- [ ] Each filter popover: open → set → **Apply** → table + count update; active-count badge; **Clear**
- [ ] **All filters** drawer: every filter in one panel; **Clear all** / **Show results**
- [ ] **Agent ⇄ Office** toggle and **All / Courted / Zillow-Realtor** toggle switch the table
- [ ] **Saved views** (save icon): save, reload, delete
- [ ] **Edit columns** (sliders): show/hide, drag reorder, reset, persists on reload
- [ ] **Export popup**: pick **method** (Clay/CSV), tick **columns**, set range
- [ ] **Download CSV** actually downloads a file with the chosen columns
- [ ] **Admin** page: tabs render; generate/revoke an API key; **invite a user** (password path); change role; view Activity
- [ ] **Webhooks**: add / edit / delete a client; **Sync campaigns**
- [ ] **Import** / **Export** pages show totals + history

## [blocked] Needs real data / external setup
- [blocked] **Send to Clay** end-to-end — needs a client with a real Clay webhook URL
- [blocked] **EmailBison campaigns populate** — needs a valid client Bison API key + confirmed `BISON_API_BASE`
- [blocked] **6-hour auto-sync** — add the `CRON_TOKEN` secret in GitHub repo settings
- [blocked] **Zillow/Realtor on-demand** + **multi-source per-source volumes** — needs the scraper connection
- [blocked] **Full Courted load (~977k)** + scale/index tuning — needs the scraper handoff
- [blocked] **"Clients using this MLS" seed** — needs the client↔MLS list

## Open items from the client
- [x] Real Supabase **service_role** key — received + set
- [ ] EmailBison API base URL confirmation + a working client key
- [ ] Sample scraper JSON payload (to confirm against the Courted columns) + the on-demand trigger spec
- [ ] Existing clients + their MLS list (for the "clients using this MLS" banner)
