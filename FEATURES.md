# Broker Staffer — Agent & Office Database (Courted replica): Full Feature List

The complete build plan lives at `~/.claude/plans/new-database-for-corofy-jolly-dahl.md`.
This file is the single, plain summary of **every feature** in scope.

## Search experience
- **Agent Search** and **Office Search** modes (top toggle; Office Search replaces Courted's "Agent type").
- **Data-source toggle:** Courted (stored permanently) vs Zillow/Realtor.com (pulled on-demand by location).
- **Courted-matched UI** — pixel-iterated from screenshots; light theme, Inter font, the same top filter bar + results table + pagination.
- Results header shows "{N} Agents found • ${volume} Sales volume".
- Sortable columns, row selection, per-page 20/50/100, pagination.

## Filters
- **Location** — search by City / Zip / County / State (type-to-search dropdown); choose which location it applies to: Office, Home, or Most-transacted (multi-select).
- **Sales Volume** — All / List-side / Buy-side + preset ranges ($0–5M … $100M+) + custom min/max.
- **Office Search (Brand & Office)** — type-to-search, Include/Exclude, grouped so you can exclude a brand AND an office at the same time.
- **MLS** — search + multi-select; **"Current clients using this MLS"** banner (from a provided client list + auto-recognized from saved lists).
- **License** — type-to-search + dropdown, Include/Exclude.
- **Other Courted filters** — Closed units, Closed transactions, Est. time in industry, Approximate GCI, Est. time in office, Average time at office, Average sales price, Units (with All/List/Buy + ranges + min/max where Courted has them).

## Data & matching
- Agents merged from **Courted + Zillow + Realtor.com** into one master record.
- **Matching waterfall:** license number → email → phone (match rate reviewed and tuned).
- **Per-source metrics kept** so conflicting sales numbers show **all three sources** side by side.
- ~28 fields per agent (name, license #, MLS affiliation, MLS ID, home/office city+zip, most-transacted city, brand, office, sales volume, % change, buy/list $ and #, GCI, avg sale price, closed transactions, units, closed rentals, avg rental price, est. time in industry/office, preferred email/phone).
- **Offices** store their own totals (from the data) and list the agents under each office.
- **MLS** comes from Courted only, deduped across accounts; consistent names/codes.
- **County/State derived from zip** automatically (so you can filter by them even though only city+zip are scraped).

## Lists & output
- **Saved lists** — save a filtered search by name, **rename**, and **re-open + keep editing** later.
- **CSV export** — any filtered or saved list, with chosen columns; handles very large lists.
- **Send to Clay** — push the filtered list to a client's Clay via that client's webhook, and pick the **EmailBison campaign** to send to.

## Data intake (from your scraper — we don't scrape)
- **Ingest webhook** the scraper POSTs to; idempotent upsert; returns a match-rate summary.
- **Courted:** loaded once, then refreshed on a weekly/monthly schedule, stored permanently (~977k now).
- **Zillow/Realtor.com:** pulled on-demand for a location, merged in, not permanently stored.

## Platform
- Login / auth, user roles, admin user management (carried over from the base system).
- Built for scale: **2–2.5M agents**, fast filtered search with approximate counts and tuned indexes.

## Build order (milestones — shown locally after each)
M0 Branding/theme → M1 Database schema → M2 Ingest webhook + sample data → **M3 Agent Search screen (live)** → M4 Location + Sales Volume filters → M5 remaining filters + Agent/Office toggle → M6 full Courted load + Office mode → M7 data-source toggle + on-demand → M8 saved lists + CSV export + Send to Clay → M9 scale tuning.
