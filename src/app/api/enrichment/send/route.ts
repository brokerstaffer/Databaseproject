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
  // which source's values win for the merged lead fields (courted | zillow | realtor)
  const sourcePriority = ["courted", "zillow", "realtor"].includes(body?.sourcePriority) ? body.sourcePriority : "courted";

  // Target campaigns: the new multi-select sends campaigns: [{ id, name, clientId }] (may span
  // several clients). Fall back to the legacy single campaignId/campaignName. campaign_id stays
  // = the first campaign so the worker's push-stage + progress guards keep working.
  const campaignList: { id: string; name: string | null }[] = (Array.isArray(body?.campaigns) ? body.campaigns : [])
    .map((c: { id?: unknown; name?: unknown }) => ({ id: c?.id != null ? String(c.id) : "", name: (c?.name as string) ?? null }))
    .filter((c: { id: string }) => c.id);
  if (campaignList.length === 0 && campaignId) campaignList.push({ id: String(campaignId), name: campaignName ?? null });
  const campaignIds = campaignList.map((c) => c.id);
  const campaignNamesJoined = campaignList.map((c) => c.name).filter(Boolean).join(", ") || null;
  const firstCampaignId = campaignIds[0] ?? null;

  const orchClientIds: string[] = Array.isArray(body?.orchClientIds) ? body.orchClientIds.filter(Boolean) : [];
  const f = filters as Record<string, unknown>;
  const filterClientIds = Array.isArray(f?.orchClientIds) ? (f.orchClientIds as string[]) : [];
  const orchClientIdForBatch = orchClientId || orchClientIds[0] || filterClientIds[0] || f?.orchClientId || null;

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo, userId: user?.id ?? null });
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
      `insert into enrichment_batches (client_id, orch_client_id, campaign_id, campaign_ids, campaign_name, total, created_by, filters, source_priority)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning id`,
      [
        clientId,
        orchClientIdForBatch,
        firstCampaignId,
        campaignIds.length ? campaignIds : null,
        campaignNamesJoined,
        agentIds.length,
        user.id,
        JSON.stringify({ filters, mode, source, selectedCount: Array.isArray(selectedIds) ? selectedIds.length : 0, rangeFrom: rangeFrom ?? null, rangeTo: rangeTo ?? null }),
        sourcePriority,
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
    details: `Queued ${agentIds.length} agents for enrichment${campaignNamesJoined ? ` -> ${campaignIds.length} EmailBison campaign${campaignIds.length > 1 ? "s" : ""} (${campaignNamesJoined})` : " (enrich only)"}`,
    meta: { kind: "enrichment_send", batchId, clientId, orchClientId: orchClientIdForBatch, campaignId: firstCampaignId, campaignIds, campaignName: campaignNamesJoined, source },
  });
  return NextResponse.json({ ok: true, batchId, queued: agentIds.length });
}
