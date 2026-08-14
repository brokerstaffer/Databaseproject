import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Add a phone number or email address for an agent, from an outside system. Token-authed like
// /api/ingest/agents, NOT session-authed, so a script can call it.
//
// IT NEVER OVERWRITES COURTED DATA. preferred_phone / preferred_email hold the MLS values and are
// left exactly as they are. The supplied value is stored ALONGSIDE them, in
// source_ids.agent_provided — the same layer the agent profile dialog writes, the table renders
// as a "provided" row, and the top-bar search looks inside.
//
// That layer is not a dead end: the enrich-worker prefers it when building a Bison lead, ahead of
// Courted, Zillow and Realtor, whatever Data priority the operator picked —
//   PRIORITY_ORDERS.courted = ["agent_provided", "courted", "zillow", "realtor"]
// and the send resolves the email the same way. So a correction is used, and the original is
// still there beside it.
//
// Fields: phone and email. They MERGE — setting a phone leaves a previously provided email in
// place. Repeat calls replace the previously PROVIDED value, never the Courted one.
//
// EMAIL REQUIRES A PRECISE MATCH — agent_id or license_number, never email or phone. Nothing is
// destroyed now, but a provided address WINS at send time, so a careless bulk write would still
// mail the wrong people: noemail@har.com matches 280 agents. A spec that breaks this rule is
// refused whole — the phone in it is not applied either — and returns "email_needs_precise_key".
//
// Body — a single update, or a batch:
//   { "match": { "license_number": "01234567" }, "phone": "+1 305 555 0142" }
//   { "match": { "license_number": "01234567" }, "email": "new@example.com" }
//   { "updates": [ { "match": {...}, "phone": "...", "email": "...", "max_matches": 5 }, ... ] }
//
// match accepts agent_id | license_number | email | phone, tried in that order (the same
// waterfall the scraper's own matcher uses). Callers rarely hold our UUIDs, so licence and email
// are the realistic keys: 79.8% of agents carry a licence, 91.1% an email, 92.9% at least one.
// Matching by email or phone looks at the provided value as well as the original, so an agent
// stays findable by whichever one the caller knows.
//
// EVERY MATCH IS UPDATED. Identifiers are not unique in this data — noemail@har.com maps to 280
// agents and the switchboard 18885195113 to 652 — so `matched` is returned on every result and a
// caller expecting one row should check it. Pass max_matches to have an update refused instead
// of applied above a given count.
//
// Reversible: the response carries a batch_id; POST it to /api/agents/contact/undo. Undo puts the
// previously provided value back, or removes the provided entry entirely if there was none —
// Courted's values are never involved either way.
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
  // Validate any email up front. A malformed address would otherwise be written verbatim and
  // then have to be undone; the whole request is rejected so a batch is never half-applied.
  const badEmail = updates.find((u: { email?: unknown }) => {
    const e = typeof u?.email === "string" ? u.email.trim() : "";
    return e !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  });
  if (badEmail) {
    return NextResponse.json(
      { error: `not a valid email address: ${String((badEmail as { email?: unknown }).email)}` },
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
    const results: { matched?: number; updated?: number; phone_updated?: number; email_updated?: number }[] = r.results ?? [];
    const totals = results.reduce<{ matched: number; updated: number; phone: number; email: number }>(
      (acc, x) => ({
        matched: acc.matched + (x.matched ?? 0),
        updated: acc.updated + (x.updated ?? 0),
        phone: acc.phone + (x.phone_updated ?? 0),
        email: acc.email + (x.email_updated ?? 0),
      }),
      { matched: 0, updated: 0, phone: 0, email: 0 }
    );

    if (totals.updated > 0) {
      await logAudit({
        action: "agent_contact_update",
        performedBy: typeof who === "string" ? who : "api",
        details: `batch ${batchId}: ${totals.phone} phone(s) + ${totals.email} email(s) updated across ${totals.matched} matched agent(s) from ${updates.length} spec(s)`,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, ...r, totals });
  } catch (e) {
    console.error("agent contact update error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 500 });
  }
}
