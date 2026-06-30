# Connecting the Scraper to Broker Staffer (no CSV)

Goal: after each scrape, the scraper **POSTs the rows directly** to Broker Staffer's ingest endpoint. No CSV download/upload. Re-scraping the same market **updates** existing agents instead of creating duplicates.

There is **no setting inside Broker Staffer** that "connects" the scraper — the connection is made **inside the scraper** by adding an HTTP request step that points at the endpoint below. Hand this page to whoever builds/runs the scraper.

---

## 1. Get an API key (one time)
In Broker Staffer: **Admin → API Keys → Generate** (name it e.g. "Courted scraper"). Copy the full key once — it looks like `bsk_...`.

## 2. Where to send the data
- **Method:** `POST`
- **URL:** `https://web-production-34f4a.up.railway.app/api/ingest/agents`
- **Headers:**
  - `Content-Type: application/json`
  - `x-ingest-token: <the API key from step 1>`

## 3. Body shape
```json
{
  "source": "courted",
  "rows": [
    { "Name": "Jane Doe", "State License": "12345", "Office": "Acme Realty", "Email": "jane@acme.com", "LTM Sales Volume": "1250000", "LTM Closed Units": "8" }
  ]
}
```
- `source` = `"courted"`, `"zillow"`, or `"realtor"`.
- `rows` = an array of agents. **Use the exact Courted CSV column names** as the keys (`Name`, `Office`, `State License`, `Email`, `Phone`, `Home City`, `Home State`, `LTM Sales Volume`, `LTM Closed Units`, `MLS`, `Member MLS ID`, etc.) — the same headers as the Courted export. Unknown keys are ignored; missing keys are just left blank.

## 4. Batching
Send **up to 2,000 rows per request**. For a large scrape, loop and POST in batches of ~1,000–2,000 until done.

## 5. What happens on the server (automatic)
- Agents are **matched** to existing records by **license → email → phone**, then **merged** (missing fields filled, the source added). So **re-scraping the same market updates the same agents — no duplicates.**
- Per-source metrics (Courted / Zillow / Realtor) are stored separately, so all three volumes can be shown.
- **Zillow/Realtor data is stored permanently**, same as Courted — re-scraping a market updates those records too.
- A success response looks like: `{ "ok": true, "received": 1000, "inserted": 940, "updated": 60 }`.

## 6. Quick test (from a terminal)
```bash
curl -X POST "https://web-production-34f4a.up.railway.app/api/ingest/agents" \
  -H "x-ingest-token: bsk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source":"courted","rows":[{"Name":"Test Agent","State License":"TEST-1","Office":"Test Office","LTM Sales Volume":"1000000"}]}'
```
A `200` with `"ok": true` means it worked. (Bad/missing key → `401`.)

---

## If the scraper has no "webhook/HTTP request" option
Then it can't post on its own, and one of these is needed (all are small):
1. **Add an HTTP POST step** in the scraper's code/flow after each run (a few lines — the request above).
2. **Bridge via Zapier/Make/n8n:** have the scraper finish into a Zap/scenario whose final step is the POST above.
3. **Scheduled forwarder:** a tiny script that reads the scraper's output (file/API) and POSTs it on a schedule.

Option 1 (a POST step in the scraper) is the cleanest "permanent connection." Send us a **sample of the scraper's output** and we can confirm the field mapping or write the small forwarder for you.
