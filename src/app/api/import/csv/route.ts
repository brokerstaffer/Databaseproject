import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { upsertAgentRows } from "@/lib/ingest/upsert-agents";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Manual CSV import from the Import page. Session-authed (unlike the token-authed scraper
// webhook) but feeds the SAME upsert pipeline — match waterfall, per-source stats, office
// aggregates, MLS junctions, and the city/county triggers all apply identically.
// Body: { source?: 'courted'|'zillow'|'realtor', rows: Row[], fileName?, chunk?, chunks?,
//         orchClientId? } — when orchClientId is set, every imported agent (new or matched)
// is also added to that client's lead list (orch_client_leads), which is what the Client
// filter queries.
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

  // optional client to attach the imported agents to
  const orchClientId = typeof body?.orchClientId === "string" && body.orchClientId ? body.orchClientId : null;
  let clientName: string | null = null;
  if (orchClientId) {
    const c = (await getPool().query(`select client_name from orch_clients where id = $1`, [orchClientId])).rows[0];
    if (!c) return NextResponse.json({ error: "client not found" }, { status: 400 });
    clientName = c.client_name;
  }

  const client = await getPool().connect();
  try {
    const { agentIds, ...result } = await upsertAgentRows(client, rows, source);
    let linked = 0;
    if (orchClientId && agentIds.length) {
      const r = await client.query(
        `insert into orch_client_leads (client_id, agent_id)
         select $1, x from unnest($2::uuid[]) x
         on conflict (client_id, agent_id) do nothing`,
        [orchClientId, agentIds]
      );
      linked = r.rowCount ?? 0;
    }
    await logAudit({
      action: "ingest",
      performedBy: user.email ?? null,
      details: `CSV import${fileName ? ` "${fileName}"` : ""}${chunkInfo} — ${source}: received ${rows.length} — ${JSON.stringify(result)}${clientName ? ` — linked ${linked} to ${clientName}` : ""}`,
      meta: { kind: "csv_import", fileName, source, received: rows.length, orchClientId, linked, ...result },
    });
    return NextResponse.json({ ok: true, source, received: rows.length, linked, client: clientName, ...result });
  } catch (e) {
    console.error("csv import error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "import failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
