import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { gatherExportRows } from "@/lib/export/gather-rows";

export const maxDuration = 300;

// Export -> Send to campaign (in-house pipeline): queues the filtered (or selected) agents
// as an enrichment batch. The enrich-worker Railway service picks it up, enriches each agent
// (cached results reused), and pushes finished leads into the chosen EmailBison campaign.
// Body: { orchClientId?, clientId?, campaignId?, campaignName?, mode?, source?, filters?, ... }
// orchClientId = orch_clients.id (preferred; the shared client table other apps maintain);
// clientId = legacy clients.id. campaignId = EmailBison numeric id; omit to enrich-only.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { orchClientId = null, clientId = null, campaignId = null, campaignName = null, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo } = body ?? {};

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }
  const agentIds = [...new Set(rows.map((r) => r.id as string).filter(Boolean))];
  if (agentIds.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });

  const pool = getPool();
  const dbc = await pool.connect();
  let batchId: string;
  try {
    await dbc.query("begin");
    const batch = await dbc.query(
      `insert into enrichment_batches (client_id, orch_client_id, campaign_id, campaign_name, total, created_by, filters)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
      [
        clientId,
        orchClientId || (filters as Record<string, unknown>)?.orchClientId || null,
        campaignId,
        campaignName,
        agentIds.length,
        user.id,
        JSON.stringify({ filters, mode, source, selectedCount: Array.isArray(selectedIds) ? selectedIds.length : 0, rangeFrom: rangeFrom ?? null, rangeTo: rangeTo ?? null }),
      ]
    );
    batchId = batch.rows[0].id;
    await dbc.query(
      `insert into enrichment_items (batch_id, agent_id)
       select $1, x.agent_id from unnest($2::uuid[]) as x(agent_id)
       on conflict (batch_id, agent_id) do nothing`,
      [batchId, agentIds]
    );
    await dbc.query("commit");
  } catch (e) {
    await dbc.query("rollback").catch(() => {});
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to queue batch" }, { status: 500 });
  } finally {
    dbc.release();
  }

  await logAudit({
    action: "enrichment_send",
    performedBy: user.email ?? null,
    details: `Queued ${agentIds.length} agents for enrichment${campaignName ? ` -> EmailBison campaign "${campaignName}"` : " (enrich only)"}`,
    meta: { kind: "enrichment_send", batchId, clientId, campaignId, campaignName, source },
  });
  return NextResponse.json({ ok: true, batchId, queued: agentIds.length });
}
