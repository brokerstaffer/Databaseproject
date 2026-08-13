import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Correct agent phone numbers from an outside system. Token-authed like /api/ingest/agents,
// NOT session-authed, so a script can call it.
//
// The ingest route cannot do this: preferred_phone is a fill-blanks-only column there, so for
// the 1,131,487 agents carrying 'courted' in sources an incoming number is silently discarded
// unless the field is empty. This route overwrites deliberately, and records what it replaced.
//
// PHONE ONLY. Email is intentionally not writable — and that is also why email stays reliable as
// a match key: nothing here ever rewrites it.
//
// Body — a single update, or a batch:
//   { "match": { "license_number": "01234567" }, "phone": "+1 305 555 0142" }
//   { "updates": [ { "match": {...}, "phone": "...", "max_matches": 5 }, ... ] }
//
// match accepts agent_id | license_number | email | phone, tried in that order (the same
// waterfall the scraper's own matcher uses). Callers rarely hold our UUIDs, so licence and email
// are the realistic keys: 79.8% of agents carry a licence, 91.1% an email, 92.9% at least one.
//
// EVERY MATCH IS UPDATED. Identifiers are not unique in this data — noemail@har.com maps to 280
// agents and the switchboard 18885195113 to 652 — so `matched` is returned on every result and a
// caller expecting one row should check it. Pass max_matches to have an update refused instead
// of applied above a given count.
//
// Reversible: the response carries a batch_id; POST it to /api/agents/contact/undo to restore
// every value that batch changed.
async function authed(req: NextRequest): Promise<boolean | string> {
  const token =
    req.headers.get("x-ingest-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return false;
  if (process.env.INGEST_TOKEN && token === process.env.INGEST_TOKEN) return "env-token";
  const { rows } = await getPool().query(
    "update api_keys set last_used_at = now() where key = $1 and revoked = false returning name",
    [token]
  );
  return rows.length > 0 ? (rows[0].name as string) : false;
}

export async function PATCH(req: NextRequest) {
  const who = await authed(req);
  if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const updates = Array.isArray(body?.updates)
    ? body.updates
    : body?.match || body?.phone
      ? [body]
      : [];

  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json(
      { error: 'expected { match: {...}, phone: "..." } or { updates: [...] }' },
      { status: 400 }
    );
  }
  if (updates.length > 5000) {
    return NextResponse.json({ error: "max 5000 updates per request" }, { status: 413 });
  }
  // Reject an attempt to write email rather than ignoring it — silently dropping a field the
  // caller believed they were setting is worse than a 400.
  if (updates.some((u: Record<string, unknown>) => u && typeof u === "object" && "email" in u)) {
    return NextResponse.json(
      { error: "email is not updatable through this endpoint; use `match.email` to identify an agent" },
      { status: 400 }
    );
  }

  const batchId = randomUUID();
  try {
    const { rows } = await getPool().query("select fn_update_agent_contact($1::jsonb, $2::uuid, $3) as r", [
      JSON.stringify(updates),
      batchId,
      typeof who === "string" ? who : "api",
    ]);
    const r = rows[0]?.r ?? { batch_id: batchId, results: [] };
    const results: { matched?: number; updated?: number }[] = r.results ?? [];
    const totals = results.reduce<{ matched: number; updated: number }>(
      (acc, x) => ({ matched: acc.matched + (x.matched ?? 0), updated: acc.updated + (x.updated ?? 0) }),
      { matched: 0, updated: 0 }
    );

    if (totals.updated > 0) {
      await logAudit({
        action: "agent_contact_update",
        performedBy: typeof who === "string" ? who : "api",
        details: `batch ${batchId}: ${totals.updated} phone(s) updated across ${totals.matched} matched agent(s) from ${updates.length} spec(s)`,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, ...r, totals });
  } catch (e) {
    console.error("agent contact update error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 500 });
  }
}
