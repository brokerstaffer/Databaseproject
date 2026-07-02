import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Campaigns for a client. All clients share one EmailBison workspace, so campaigns are
// associated by NAME: "Client Name + Sender + Market" → the part before the first " + "
// equals the client's name. Feeds the Export popup dropdown.
export async function GET(req: NextRequest) {
  const clientId = new URL(req.url).searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ campaigns: [] });

  const pool = getPool();
  const client = (await pool.query("select name from clients where id = $1", [clientId])).rows[0];
  if (!client) return NextResponse.json({ campaigns: [] });

  const { rows } = await pool.query(
    // bison_id = EmailBison's numeric campaign id (raw.id, e.g. 67) — the id Clay/Bison expects.
    // bison_campaign_id stays the internal UUID key; fall back to it only if raw.id is absent.
    `select id, bison_campaign_id, coalesce(raw->>'id', bison_campaign_id) as bison_id, name, status
       from bison_campaigns
      where lower(trim(split_part(name, ' + ', 1))) = lower(trim($1))
         or lower(name) like lower(trim($1)) || ' +%'
      order by name`,
    [client.name]
  );
  return NextResponse.json({ campaigns: rows });
}
