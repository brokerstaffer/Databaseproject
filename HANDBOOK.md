# Broker Staffer — User Handbook

A practical guide to using the Broker Staffer agent & office database: searching, filtering, building lists, exporting to CSV or Clay, managing clients, and administering the system.

**Live app:** https://web-production-34f4a.up.railway.app

---

## Table of contents

1. [What Broker Staffer is](#1-what-broker-staffer-is)
2. [Getting started](#2-getting-started)
3. [The Agent Search screen](#3-the-agent-search-screen)
4. [Filters](#4-filters)
5. [Saved views (quick filters)](#5-saved-views-quick-filters)
6. [Editing columns](#6-editing-columns)
7. [Exporting (CSV & Send to Clay)](#7-exporting-csv--send-to-clay)
8. [Clients & Webhooks](#8-clients--webhooks)
9. [EmailBison campaigns](#9-emailbison-campaigns)
10. [Import & where the data comes from](#10-import--where-the-data-comes-from)
11. [Admin](#11-admin)
12. [How multi-source data merges](#12-how-multi-source-data-merges)
13. [Roles & permissions](#13-roles--permissions)
14. [Step-by-step procedures (SOPs)](#14-step-by-step-procedures-sops)
15. [Troubleshooting & FAQ](#15-troubleshooting--faq)
16. [Current limitations / coming soon](#16-current-limitations--coming-soon)

---

## 1. What Broker Staffer is

Broker Staffer is a searchable database of **real-estate agents and offices**, modeled on Courted. You use it to:

- **Search and filter** agents (or offices) by location, sales volume, brand/office, MLS, license, production metrics, and more.
- **Build targeted lists** and save them for reuse.
- **Export** those lists as a CSV file, or **send them straight to a client's Clay workbook** to kick off outreach (including selecting the EmailBison campaign).
- **Manage clients**, their Clay webhooks, and their EmailBison campaigns.

The agent data comes from **Courted** (stored permanently and refreshed on a schedule) and, on demand, from **Zillow / Realtor.com**. Data is collected by a separate scraper and loaded into Broker Staffer automatically.

---

## 2. Getting started

### Signing in
1. Open the app URL.
2. Enter your **email** and **password**, then click **Sign In**.
3. You'll land on the **Agent Search** screen.

**Forgot your password?** Click **Forgot password?** on the sign-in screen, enter your email, and you'll receive a reset link.

### The layout
- **Top bar** — the Broker Staffer logo, the screen title, and your **account menu** (top-right avatar) with **Sign out**.
- **Left navigation rail** — icons for each section:
  - **Agent Search** — the main search/list screen.
  - **Import** — data totals and a history of incoming data loads.
  - **Export** — a history of your CSV downloads and Clay sends.
  - **Webhooks** — manage clients (their Clay webhook + EmailBison key).
  - **Admin** — (admins only) data webhook, API keys, users, activity.

---

## 3. The Agent Search screen

This is where you do most of your work.

### Top of the screen
- **Title + mode toggle** — switch between **Agent** and **Office** views (see below).
- **Data source toggle** — **All · Courted · Zillow / Realtor** (see below).
- **Filter bar** — the filter buttons (Location, Sales volume, Office Search, MLS, Title, License, and the production-metric filters), plus an **All filters** button that opens every filter in one panel.

### Results area
- **Count line** — e.g. *"453,273 Agents found · $878.7B Sales volume"* — updates as you filter.
- **Action icons** (right side):
  - **Edit columns** (sliders icon) — choose and reorder the table columns.
  - **Export** (download icon) — open the export popup.
  - **Saved views** (save icon) — save the current filters or load a saved one.
- **Table** — one row per agent (or office). Click a **column header** to sort; click again to reverse. Use the **checkboxes** to select specific rows.
- **Pagination** (bottom) — choose **20 / 50 / 100** rows per page and move between pages.

### Agent vs Office mode
- **Agent** (default) — each row is an agent, with all agent columns.
- **Office** — each row is an **office**, showing the office's totals (sales volume, units, etc.) and the **agents who work there**. Use this to browse by brokerage rather than by individual.

### Data source toggle
- **All** — every agent in the database, regardless of source.
- **Courted** — only agents from the Courted dataset (the permanently-stored data).
- **Zillow / Realtor** — only agents pulled from Zillow/Realtor. These are gathered **on demand by location** and are not stored permanently. *(This source is wired but waiting on the scraper connection — see [section 16](#16-current-limitations--coming-soon).)*

Whatever source you're viewing is the source your **export** uses.

---

## 4. Filters

Filters live in two places that stay in sync:
- The **filter buttons** along the top (open one at a time in a small popover).
- The **All filters** panel (the **All filters** button) — every filter in one scrollable drawer with a single **Show results** button.

Most filter popovers work the same way: make your selections, then click **Apply** (or **Clear** to reset that filter). The **All filters** drawer collects everything and you click **Show results** once.

The **All filters** button shows a **badge with the number of active filters**.

### The three main filters

**Location**
- Pick what you're searching by: **City, Zip code, County, or State**.
- Start typing — matching places appear in a dropdown; click to add them (up to 50).
- Choose **which location to match**: **Office location**, **Most transacted location**, and/or **Home location** (any combination).

**Sales volume**
- Choose **All**, **List-side**, or **Buy-side**.
- Pick one or more preset ranges (e.g. *$0–$5M, $5M–$10M, … $100M+*) and/or enter a custom **Min / Max**.

**Office Search**
- Choose **Brand** or **Office** (a brand is the parent company; an office is a branch of it).
- Choose **Include** or **Exclude**, then type to find and add brands/offices.
- This is a **grouped** filter — you can, for example, **exclude a brand** *and* **exclude a specific office** at the same time.

### Other filters

- **MLS** — search and tick the MLS databases you want. When you select an MLS, a banner shows **"Current clients using this MLS: …"** (see note below).
- **License number** — type to search license numbers and **Include** or **Exclude** them.
- **Title** — Include/Exclude by role (Salesperson, Team Leader, Managing Broker).
- **Closed units** and **Closed transactions** — All/List/Buy + preset ranges + Min/Max.
- **Est. time in industry** and **Est. time in office** and **Average time at office** — preset year ranges + Min/Max (in years).
- **Approx. GCI** and **Average sales price** — dollar ranges + Min/Max.

### "Current clients using this MLS"
When you pick an MLS, the banner tells you which of your clients already use it. It draws from two places:
1. A **provided list** of existing clients and the MLS each uses.
2. Your **saved views** — if you saved a view named after a client and that view selected an MLS, choosing that MLS later will show the client's name.

---

## 5. Saved views (quick filters)

Save a set of filters so you can re-run it any time.

- **Save:** set up your filters, click the **save icon** (top-right of the results), type a name, click **Save**.
- **Load:** click the **save icon**, then click any saved view to apply its filters instantly.
- **Delete:** click the trash icon next to a saved view.

Saved views are **per user**. Naming a view after a client also feeds the "Current clients using this MLS" banner.

---

## 6. Editing columns

Click the **sliders icon** (top-right of the results) to open **Edit columns**:
- **Show/hide** any column with its checkbox.
- **Drag** columns in the right-hand list to reorder them.
- **Agent** and **Office** are always kept (locked).
- **Reset to default** restores the original set and order.

Your column choices are remembered on your device.

---

## 7. Exporting (CSV & Send to Clay)

Click the **download / export icon** (top-right of the results) to open the **Export** popup. The same popup handles both export methods.

### Step 1 — Choose a method
- **Send to Clay** — push the list to a client's Clay workbook.
- **Download CSV** — download the list as a spreadsheet file.

### Step 2 — (Clay only) Choose client & campaign
- **Client** — pick the client; their Clay webhook is used. *(If a client has no webhook, you'll see a warning — add one on the Webhooks page first.)*
- **EmailBison campaign** — pick the campaign this list should feed.

### Step 3 — Choose columns
- Tick exactly the columns you want exported (use **Select all** / **Clear**).
- This applies to **both** CSV and Clay.

### Step 4 — Choose the range (optional)
- Leave blank to export **all** filtered results, or enter a **From / To** row range.
- If you ticked specific rows in the table, those selected rows are exported instead.

### Step 5 — Export
- Click **Download CSV** or **Send to Clay**.

The export uses the **data source** currently selected (All / Courted / Zillow-Realtor). Every export is logged on the **Export** page.

---

## 8. Clients & Webhooks

Open **Webhooks** in the left nav to manage clients. Each client has:
- **Name**
- **Clay webhook URL** — where "Send to Clay" delivers this client's lists.
- **EmailBison API key** — used to pull this client's campaigns.

**To add a client:** click **Add client**, fill in the name, Clay webhook, and (optionally) the EmailBison API key, then save.
**To edit or remove:** use the edit / delete controls on the client row.

**Sync campaigns** — click this to refresh every client's EmailBison campaigns immediately (see next section).

---

## 9. EmailBison campaigns

Each client's EmailBison campaigns are pulled in using their **API key** (set on the Webhooks page) and cached so they appear instantly in the **Send to Clay** campaign dropdown.

- Campaigns refresh **automatically every 6 hours**.
- You can refresh **on demand** with the **Sync campaigns** button on the Webhooks page.
- The campaign dropdown in the Export popup always shows **only the selected client's** campaigns.

---

## 10. Import & where the data comes from

Open **Import** in the left nav to see:
- **Totals** — how many agents, offices, and MLS records are in the database.
- **Recent imports** — a history of data loads coming in from the scraper.
- A shortcut to the **ingest endpoint and API keys** (under Admin).

**How data gets in:** a separate scraper collects agent data and sends it to Broker Staffer's **ingest endpoint**, authenticated with an **API key**. Courted data is loaded once and refreshed on a schedule; Zillow/Realtor data is fetched on demand by location.

You don't load data by hand — it arrives through the scraper. The Import page is where you confirm it landed.

---

## 11. Admin

Open **Admin** in the left nav (admins/owners only). It has four sections:

### Users
- See all users with their role and status.
- **Invite user** — enter an email, name, role, and optionally a temporary password.
- **Change a role** inline, **reset a password**, or **delete** a user.

### API Keys
- **Generate** a key to give the scraper (name it, e.g. "Courted scraper"). The full key is shown **once** — copy it immediately.
- See each key's **last used** time and **revoke** any key.
- These keys authenticate data coming into the ingest endpoint.

### Data Webhook
- The **endpoint URL** the scraper posts agent data to, the required **auth header**, and an **example payload**. Copy these to hand to whoever runs the scraper.

### Activity
- A running log of notable actions: data imports, exports, Clay sends, API-key changes, and user changes — with who did it and when.

---

## 12. How multi-source data merges

When the same agent appears in more than one source (Courted, Zillow, Realtor), Broker Staffer combines them into **one record** for the best coverage:

1. **Matching** — it decides whether two records are the same person by checking, in order: **license number → email → phone**. License is the most reliable; the others are fallbacks.
2. **Merging** — a matched record is **updated, not duplicated**: missing fields get filled in, and the new source is added to the agent's source list.
3. **Per-source numbers are kept** — each source's sales volume and units are stored **separately**, so conflicting figures aren't overwritten.
4. **Display** — when an agent has more than one source, the **Sales volume** cell shows a small per-source breakdown (e.g. *courted: $1.2M / zillow: $1.1M*). With a single source, it just shows the one number.

---

## 13. Roles & permissions

| Role | What they can do |
|---|---|
| **Owner** | Everything, including managing users. |
| **Admin** | Everything, including managing users and the Admin section. |
| **Manager** | Search, filter, save views, and export. |
| **Viewer** | Search, filter, and view. |

The **Admin** section and the **Webhooks** page are limited to owners/admins.

---

## 14. Step-by-step procedures (SOPs)

### SOP A — Build a targeted list and send it to a client
1. Go to **Agent Search**.
2. Set the **data source** (usually **Courted** or **All**).
3. Apply your filters (Location, Sales volume, Office Search, MLS, etc.). Use **All filters** for everything at once.
4. Check the **count** to confirm the list size looks right; sort/spot-check the table.
5. *(Optional)* Click the **save icon** to save these filters as a named view for reuse.
6. Click the **export icon** → choose **Send to Clay**.
7. Pick the **client** and the **EmailBison campaign**.
8. Tick the **columns** to include; set a **range** if you only want part of the list.
9. Click **Send to Clay**. Confirm the success message.

### SOP B — Download a list as CSV
1. Build your filtered list (steps 1–4 above).
2. Click the **export icon** → choose **Download CSV**.
3. Tick the **columns** you want; set a **range** if needed.
4. Click **Download CSV** — the file downloads to your computer.

### SOP C — Add a new client
1. Go to **Webhooks** → **Add client**.
2. Enter the **client name** and **Clay webhook URL**.
3. *(Optional)* Paste the client's **EmailBison API key**.
4. Save. Click **Sync campaigns** so their campaigns appear in the export popup.

### SOP D — Give the scraper an API key
1. Go to **Admin → API Keys**.
2. Click **Generate**, name it (e.g. "Courted scraper"), and **copy the full key now** (it won't be shown again).
3. From **Admin → Data Webhook**, copy the **endpoint URL** and **auth header**.
4. Hand the URL + key to whoever runs the scraper.

### SOP E — Invite a teammate
1. Go to **Admin → Users → Invite user**.
2. Enter their **email**, **name**, and **role**.
3. Either set a **temporary password** (they can sign in right away) or leave it blank to send an email invite.
4. Save.

### SOP F — Save and reuse a quick filter
1. Apply the filters you want.
2. Click the **save icon** → name it → **Save**.
3. Next time, click the **save icon** and select the view to re-apply it.

---

## 15. Troubleshooting & FAQ

**My saved view doesn't appear.** Reopen the save icon (it loads your views fresh each time). If it's still missing, refresh the page.

**Send to Clay is greyed out / errors.** The selected client needs a **Clay webhook URL** — add it on the **Webhooks** page.

**No campaigns show for a client.** The client needs an **EmailBison API key** on the Webhooks page; then click **Sync campaigns**.

**Zillow / Realtor shows no results.** That source is fetched **on demand** and isn't connected yet — use **Courted** or **All** for now.

**The per-source volume breakdown isn't showing.** It only appears when an agent has data from **more than one source**. Today the data is Courted-only, so it shows a single number.

**A column is missing from my table.** Open **Edit columns** and tick it (or **Reset to default**).

**I can't see the Admin section.** It's limited to **owners/admins**. Ask an owner to adjust your role.

---

## 16. Current limitations / coming soon

- **Zillow / Realtor on-demand** — the toggle, matching, merging, and per-source display are all in place, but the live on-demand fetch from the scraper is **not connected yet**.
- **Full Courted dataset** — the system is loaded with a sample today; the full ~977k-agent load happens once the scraper handoff is complete.
- **Active listings filter** — not available (the source data doesn't currently include it).

---

*This handbook describes how to use Broker Staffer through the app. For data questions (what's loaded, when it last refreshed), check the **Import** page and the **Admin → Activity** log.*
