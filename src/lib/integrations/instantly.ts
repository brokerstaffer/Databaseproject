// Instantly.ai API v2 client. Mirrors src/lib/integrations/bison.ts in shape and in its refusal to
// return a silently-truncated list, because the caller REPLACES rows with whatever comes back.
//
// Auth is `Authorization: Bearer <INSTANTLY_API_KEY>` — the same key and convention already used
// for email verification in scripts/enrich-flow.mjs. Pagination is CURSOR based throughout:
// pass `starting_after` with the previous response's `next_starting_after`.
//
// Verified against the live workspace before this was written:
//   POST /leads/list  {limit:100, filter:"FILTER_VAL_REPLIED"}  ~1.2 s per 100 rows
//   GET  /campaigns?limit=100                                   313 campaigns
const BASE = "https://api.instantly.ai/api/v2";
const HEADERS = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

export interface InstantlyCampaign {
  campaign_id: string;
  name: string | null;
}

export interface InstantlyRepliedLead {
  email: string;
  campaign_id: string | null;
  reply_count: number | null;
  last_reply_at: string | null;
}

/** Every campaign in the workspace, for names and for client attribution. */
export async function fetchCampaigns(apiKey: string): Promise<InstantlyCampaign[]> {
  const out: InstantlyCampaign[] = [];
  const MAX_PAGES = 100; // 313 campaigns today; the cap is a runaway guard, not a limit
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url: string = `${BASE}/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
    const res: Response = await fetch(url, { headers: HEADERS(apiKey), signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`Instantly campaigns ${res.status} ${res.statusText}`);
    const json: Record<string, unknown> = await res.json();
    const items: Record<string, unknown>[] = Array.isArray(json?.items) ? (json.items as Record<string, unknown>[]) : [];
    for (const c of items) {
      if (c.id) out.push({ campaign_id: String(c.id), name: (c.name as string) ?? null });
    }
    after = (json?.next_starting_after as string | undefined) ?? null;
    if (!after || items.length === 0) return out;
  }
  throw new Error(`Instantly campaigns: exceeded ${MAX_PAGES} pages`);
}

/**
 * Every lead in the workspace that has replied. This is the direct analogue of EmailBison's
 * `filters[lead_campaign_status]=replied` sweep.
 *
 * FAILS LOUD rather than returning a partial list: the caller replaces the whole mirror table with
 * this result, so a truncated read would silently clear reply flags. Same reasoning as
 * bison.ts:69-72. A full page with no cursor, or hitting the page cap, throws.
 */
export async function fetchRepliedLeads(apiKey: string): Promise<InstantlyRepliedLead[]> {
  const out: InstantlyRepliedLead[] = [];
  const MAX_PAGES = 500; // ~40 pages for the current 3,957 replies
  let after: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body: Record<string, unknown> = { limit: 100, filter: "FILTER_VAL_REPLIED" };
    if (after) body.starting_after = after;
    const res: Response = await fetch(`${BASE}/leads/list`, {
      method: "POST",
      headers: HEADERS(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`Instantly leads/list ${res.status} ${res.statusText}`);
    const json: Record<string, unknown> = await res.json();
    if (!Array.isArray(json?.items)) throw new Error("Instantly leads/list: unexpected response shape");
    const items: Record<string, unknown>[] = json.items as Record<string, unknown>[];
    for (const l of items) {
      const email = String(l.email ?? "").trim().toLowerCase();
      if (!email.includes("@")) continue;
      out.push({
        email,
        campaign_id: l.campaign ? String(l.campaign) : null,
        reply_count: typeof l.email_reply_count === "number" ? l.email_reply_count : null,
        last_reply_at: (l.timestamp_last_reply as string) ?? null,
      });
    }
    after = (json?.next_starting_after as string | undefined) ?? null;
    if (items.length === 0) return out;
    if (!after) {
      // a full page with no cursor means there may be more we cannot reach — never return a
      // truncated list to a caller that is about to replace the table with it
      if (items.length >= 100) throw new Error("Instantly leads/list: full page with no next cursor");
      return out;
    }
  }
  throw new Error(`Instantly leads/list: exceeded ${MAX_PAGES} pages`);
}
