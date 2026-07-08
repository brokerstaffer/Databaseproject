import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Campaigns for a client. All clients share one EmailBison workspace, so campaigns are
// associated by NAME: "Client Name + Sender + Market" → the part before the first " + "
// equals the client's name. Orchestrator clients (orch_clients) may also carry the campaign
// id directly (bison_campaign_id) — that campaign is always included. Feeds the Export popup.
// Params: orchClientId (orch_clients.id — preferred) or clientId (legacy clients.id).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const orchClientId = url.searchParams.get("orchClientId");
  const clientId = url.searchParams.get("clientId");
  if (!orchClientId && !clientId) return NextResponse.json({ campaigns: [] });

  const pool = getPool();
  let name: string | null = null;
  let directCampaignId: string | null = null;
  if (orchClientId) {
    const c = (await pool.query("select client_name, bison_campaign_id from orch_clients where id = $1", [orchClientId])).rows[0];
    if (!c) return NextResponse.json({ campaigns: [] });
    name = c.client_name;
    directCampaignId = c.bison_campaign_id;
  } else {
    const c = (await pool.query("select name from clients where id = $1", [clientId])).rows[0];
    if (!c) return NextResponse.json({ campaigns: [] });
    name = c.name;
  }

  const { rows } = await pool.query(
    // bison_id = EmailBison's numeric campaign id (raw.id, e.g. 67) — the id the send expects.
    // bison_campaign_id stays the internal UUID key; fall back to it only if raw.id is absent.
    `select id, bison_campaign_id, coalesce(raw->>'id', bison_campaign_id) as bison_id, name, status
       from bison_campaigns
      where lower(trim(split_part(name, ' + ', 1))) = lower(trim($1))
         or lower(name) like lower(trim($1)) || ' +%'
         or ($2::text is not null and coalesce(raw->>'id', bison_campaign_id) = $2)
      order by name`,
    [name ?? "", directCampaignId]
  );
  return NextResponse.json({ campaigns: rows });
}
