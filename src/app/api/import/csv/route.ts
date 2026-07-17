import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { upsertAgentRows } from "@/lib/ingest/upsert-agents";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Manual CSV import from the Import page. Session-authed (unlike the token-authed scraper
// webhook) but feeds the SAME upsert pipeline — match waterfall, per-source stats, office
// aggregates, MLS junctions, and the city/county triggers all apply identically.
// Body: { source?: 'courted'|'zillow'|'realtor', rows: Row[], fileName?, chunk?, chunks? }
// Rows arrive already mapped to the Courted column names (the ingest row keys).
const MAX_ROWS = 2000;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const source = ["courted", "zillow", "realtor"].includes(body?.source) ? (body.source as string) : "courted";
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length === 0) return NextResponse.json({ error: "expected { rows: [...] }" }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `max ${MAX_ROWS} rows per request` }, { status: 413 });

  const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 120) : null;
  const chunkInfo = body?.chunk && body?.chunks ? ` (chunk ${body.chunk}/${body.chunks})` : "";

  const client = await getPool().connect();
  try {
    const result = await upsertAgentRows(client, rows, source);
    await logAudit({
      action: "ingest",
      performedBy: user.email ?? null,
      details: `CSV import${fileName ? ` "${fileName}"` : ""}${chunkInfo} — ${source}: received ${rows.length} — ${JSON.stringify(result)}`,
      meta: { kind: "csv_import", fileName, source, received: rows.length, ...result },
    });
    return NextResponse.json({ ok: true, source, received: rows.length, ...result });
  } catch (e) {
    console.error("csv import error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "import failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
