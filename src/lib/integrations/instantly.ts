// Instantly.ai API v2 client. Mirrors src/lib/integrations/bison.ts in shape and in its refusal to
// return a silently-truncated list, because the caller REPLACES rows with whatever comes back.
//
// Auth is `Authorization: Bearer <INSTANTLY_API_KEY>` — the same key and convention already used
// for email verification in scripts/enrich-flow.mjs. Pagination is CURSOR based throughout:
// pass `starting_after` with the previous response's `next_starting_after`.
//
// Measured against the live workspace before this was written:
//   POST /leads/list {filter:"FILTER_VAL_REPLIED"}    78 pages     7,774 emails
//   POST /leads/list {filter:"FILTER_VAL_BOUNCED"}    69 pages     6,499 emails      39 s
//   POST /leads/list {}            (all members)   1,682 pages   149,140 emails / 212 campaigns
//                                                                                    854 s
//   GET  /campaigns?limit=100                        313 campaigns
//
// The membership sweep returns one row per (lead, campaign) — 168,056 rows for 149,140 distinct
// emails — which is exactly what campaign_count and the multi-campaign filter need.
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

export interface InstantlyLead {
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
 * The one paginator behind all three lead sweeps.
 *
 * FAILS LOUD rather than returning a partial list: every caller replaces the mirror with this
 * result, so a truncated read would silently clear reply and bounce flags — the same class of bug
 * that wiped the Bison bounce data (see the header of api/cron/bison-sync/route.ts). A full page
 * with no cursor, or hitting the page cap, throws.
 *
 * `onPage` lets a long sweep report progress without this function knowing what it is for.
 */
async function listLeads(
  apiKey: string,
  filter: string | null,
  label: string,
  maxPages: number,
  onPage?: (page: number, rows: number) => void
): Promise<InstantlyLead[]> {
  const out: InstantlyLead[] = [];
  let after: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const body: Record<string, unknown> = { limit: 100 };
    if (filter) body.filter = filter;
    if (after) body.starting_after = after;
    const res: Response = await fetch(`${BASE}/leads/list`, {
      method: "POST",
      headers: HEADERS(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`Instantly ${label} ${res.status} ${res.statusText}`);
    const json: Record<string, unknown> = await res.json();
    if (!Array.isArray(json?.items)) throw new Error(`Instantly ${label}: unexpected response shape`);
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
    onPage?.(page, out.length);
    after = (json?.next_starting_after as string | undefined) ?? null;
    if (items.length === 0) return out;
    if (!after) {
      // a full page with no cursor means there may be more we cannot reach — never return a
      // truncated list to a caller that is about to replace the table with it
      if (items.length >= 100) throw new Error(`Instantly ${label}: full page with no next cursor`);
      return out;
    }
  }
  throw new Error(`Instantly ${label}: exceeded ${maxPages} pages`);
}

/** Leads that have replied. The direct analogue of EmailBison's replied sweep. */
export function fetchRepliedLeads(apiKey: string): Promise<InstantlyLead[]> {
  return listLeads(apiKey, "FILTER_VAL_REPLIED", "leads/list replied", 500);
}

/** Leads whose email bounced. 69 pages today; the cap is a runaway guard. */
export function fetchBouncedLeads(apiKey: string): Promise<InstantlyLead[]> {
  return listLeads(apiKey, "FILTER_VAL_BOUNCED", "leads/list bounced", 500);
}

/**
 * Every lead in every campaign — the membership mirror, one row per (lead, campaign).
 *
 * 1,682 pages / ~14 minutes today, so the cap is set well clear of it: hitting a cap THROWS, and
 * throwing here means the sync keeps the previous mirror rather than replacing it with a partial
 * one. 20,000 pages is ~2M leads.
 */
export function fetchAllLeads(
  apiKey: string,
  onPage?: (page: number, rows: number) => void
): Promise<InstantlyLead[]> {
  return listLeads(apiKey, null, "leads/list membership", 20000, onPage);
}
