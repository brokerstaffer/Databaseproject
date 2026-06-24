# Broker Staffer — Testing Checklist

App: **http://localhost:3001** (dev). Sign in with the Supabase Auth user you created.
Data: 20 Courted (NABOR / Naples) agents seeded.

Legend: `[ ]` to test · `[x]` verified · `[blocked]` needs config/data

---

## Access & shell
- [ ] Login works; lands on **Agent Search** (`/search`)
- [ ] Dark top bar: logo, "Search Broker Staffer", clipboard, bell, avatar
- [ ] Avatar menu → **Sign out** works
- [ ] Left nav: Agent Search · Import · Export · Webhooks (active state highlights)

## Agent Search — table
- [ ] Shows "20 Agents found • $3.0B Sales volume"
- [ ] 28 columns render (Agent → Preferred phone number)
- [ ] `% Change` green (+) / red (−); money right-aligned; tenure as "yrs/mos"; blanks "N/A"/"None"
- [ ] Column sort (Agent, Sales volume, Units, Avg sale price, Closed transactions, Est. time)
- [ ] Pagination: Items per page 20/50/100; "out of N"
- [ ] Row checkboxes select; select-all

## Filters (each: open → set → Apply → counts + rows update)
- [ ] **Location** — pick City/Zip/County/State; type (e.g. "Naples") → suggestion; add chip; toggle Office/Most-transacted/Home
- [ ] **Sales volume** — All/List/Buy + range pills ($0–5M…$100M+) + Min/Max
- [ ] **Office Search** — Brand/Office switch + Include/Exclude; add brand AND office exclusions together (grouped)
- [ ] **MLS** — search list, check NABOR; "Current clients using this MLS" banner [blocked: needs client/list data]
- [ ] **Title** — Include/Exclude Salesperson / Team Leader / Managing Broker
- [ ] **Closed units** / **Closed transactions** — All/List/Buy + 1-5/5-10/10-20/20+ + Min/Max
- [ ] **Est. time in industry** — 0-1yr…10+yrs + Min/Max yrs
- [ ] **Approx. GCI** — $ buckets + Min/Max
- [ ] Active filters show a count badge on the pill; clearing resets

## Top-right icons (Agent Search)
- [ ] **Edit columns** (settings) — show/hide + reorder; Agent/Office locked; reset to default; persists
- [ ] **Export** (download) — opens Send-to-Clay popup
- [ ] **Save** (save) — save current filters as a named quick-filter; reload it later

## Export → Send to Clay  [blocked: needs a client + real Clay webhook]
- [ ] Webhooks → Add client with a Clay webhook URL
- [ ] Agent Search → filter → Export → pick client + campaign + range → Send
- [ ] Data arrives in the client's Clay table with campaign attached

## Webhooks (clients)
- [ ] Add client (name + Clay webhook + Bison API key); Bison key shows "Set"
- [ ] Edit / Delete client
- [ ] **Sync campaigns** button [blocked: needs real Bison API key + correct BISON_API_BASE]

## EmailBison sync  [blocked: confirm base URL + add a client API key]
- [ ] Confirm `BISON_API_BASE` (currently `https://app.outboundhero.co/api`)
- [ ] Add client Bison key → Sync campaigns → campaigns populate
- [ ] Campaigns appear in the Export popup dropdown
- [ ] 6h auto-sync: scheduler hits `POST /api/cron/bison-sync` with `x-cron-token` [blocked: after deploy]

## Scraper ingest webhook  [verified locally; needs scraper integration]
- [x] `POST /api/ingest/agents` with `x-ingest-token` upserts (idempotent); 401 without token
- [ ] Point the scraper at it (Courted-CSV-shaped JSON rows: `{ source, rows: [...] }`)
- [ ] Send a sample scraper payload so we can confirm/adjust the field mapping

## Left-nav pages (stubs for now)
- [ ] **Import** — show ingest history / source counts (not built yet)
- [ ] **Export** — show export history (not built yet)

## Not built yet / next
- [ ] **All filters** drawer (right sheet with every filter in one place)
- [ ] License filter
- [ ] Data-source toggle (Courted vs on-demand Zillow/Realtor)
- [ ] Full Courted load (~977k) + office/brand aggregation + scale tuning

## Open items needed from client
- [ ] Real Supabase **service_role** key (current value is the anon key)
- [ ] EmailBison API base URL confirmation + method (GET vs POST — docs were ambiguous)
- [ ] Sample scraper JSON payload
- [ ] Existing clients + their MLS list (for the "clients using this MLS" banner)
