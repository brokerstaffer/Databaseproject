import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { upsertAgentRows } from "@/lib/ingest/upsert-agents";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Scraper -> us ingest webhook. Token-authed (shared secret), NOT session-authed.
// Body: { source?: "courted"|"zillow"|"realtor", requestId?: string, rows: Row[] }
// Rows are keyed by the Courted CSV column names (see /Downloads sample).
export async function POST(req: NextRequest) {
  const token =
    req.headers.get("x-ingest-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  // Accept the env INGEST_TOKEN or any non-revoked key from the Admin > API Keys tab.
  let authed = !!process.env.INGEST_TOKEN && token === process.env.INGEST_TOKEN;
  if (!authed && token) {
    const { rows } = await getPool().query(
      "update api_keys set last_used_at = now() where key = $1 and revoked = false returning id",
      [token]
    );
    authed = rows.length > 0;
  }
  if (!authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const source = (body?.source ?? "courted") as string;
  const rows = Array.isArray(body?.rows) ? body.rows : Array.isArray(body) ? body : [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "expected { rows: [...] }" }, { status: 400 });
  }
  if (rows.length > 2000) {
    return NextResponse.json({ error: "max 2000 rows per request" }, { status: 413 });
  }

  const client = await getPool().connect();
  try {
    const result = await upsertAgentRows(client, rows, source);
    await logAudit({ action: "ingest", performedBy: "scraper", details: `${source}: received ${rows.length} — ${JSON.stringify(result)}` });
    return NextResponse.json({ ok: true, source, received: rows.length, ...result });
  } catch (e) {
    console.error("ingest error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "ingest failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
