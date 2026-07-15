import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Campaigns for one or more clients. All clients share one EmailBison workspace, so campaigns
// are associated by NAME: "Client Name + Sender + Market" → the part before the first " + "
// equals the client's name. Orchestrator clients (orch_clients) may also carry the campaign id
// directly (bison_campaign_id) — that campaign is always included. Feeds the Export popup.
// Params (any one):
//   orchClientIds=id1,id2  — preferred; multi-select. Campaigns come back tagged per client.
//   orchClientId=id        — single orch client (back-compat).
//   clientId=id            — legacy clients.id (single).
// Response: { campaigns: [{ id, bison_campaign_id, bison_id, name, status, client_id, client_name }] }
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const orchClientIds = (url.searchParams.get("orchClientIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const orchClientId = url.searchParams.get("orchClientId");
  const clientId = url.searchParams.get("clientId");
  if (orchClientId && !orchClientIds.includes(orchClientId)) orchClientIds.push(orchClientId);

  const pool = getPool();

  // Resolve each requested client to its { id, name, directCampaignId } so campaigns can be
  // tagged back to the client they belong to.
  const resolved: { id: string | null; name: string | null; directCampaignId: string | null }[] = [];
  if (orchClientIds.length) {
    const { rows } = await pool.query(
      "select id, client_name, bison_campaign_id from orch_clients where id = any($1::uuid[])",
      [orchClientIds]
    );
    for (const r of rows) resolved.push({ id: r.id, name: r.client_name, directCampaignId: r.bison_campaign_id });
  } else if (clientId) {
    const c = (await pool.query("select id, name from clients where id = $1", [clientId])).rows[0];
    if (c) resolved.push({ id: c.id, name: c.name, directCampaignId: null });
  }
  if (resolved.length === 0) return NextResponse.json({ campaigns: [] });

  // One query per client (the set is tiny — the operator picked these), tagging each row with
  // its client so the dialog can group campaigns under their client.
  const perClient = await Promise.all(
    resolved.map(async (c) => {
      const { rows } = await pool.query(
        // bison_id = EmailBison's numeric campaign id (raw.id, e.g. 67) — the id the send expects.
        // bison_campaign_id stays the internal UUID key; fall back to it only if raw.id is absent.
        `select id, bison_campaign_id, coalesce(raw->>'id', bison_campaign_id) as bison_id, name, status,
                ($2::text is not null and coalesce(raw->>'id', bison_campaign_id) = $2) as is_default
           from bison_campaigns
          where lower(trim(split_part(name, ' + ', 1))) = lower(trim($1))
             or lower(name) like lower(trim($1)) || ' +%'
             or ($2::text is not null and coalesce(raw->>'id', bison_campaign_id) = $2)
          order by name`,
        [c.name ?? "", c.directCampaignId]
      );
      return rows.map((r) => ({ ...r, client_id: c.id, client_name: c.name }));
    })
  );

  return NextResponse.json({ campaigns: perClient.flat() });
}
