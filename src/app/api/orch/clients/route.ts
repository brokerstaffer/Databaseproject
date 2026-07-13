import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// Orchestrator clients (orch_clients — the source of truth, written by Masterinbox and other
// apps) + how many agents were built for each (orch_client_leads). Feeds the "Client" filter
// dropdown, the Clients page, and the export dialog's client picker.
// ?inReview=1 -> only clients whose leads are up for review (leads_inreview = true) — the
// main-UI Client filter uses this so operators only see clients awaiting review.
// orch_* tables have no RLS grants for app users, so this reads via the pool behind an auth gate.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const inReviewOnly = new URL(req.url).searchParams.get("inReview") === "1";
  const pool = getPool();
  const [{ rows }, sync] = await Promise.all([
    pool.query(
      `select c.id, c.client_name, c.status, c.mls, c.location, c.bison_campaign_id,
              c.leads_inreview, c.bison_leads_exported, c.created_at,
              (c.portal_url is not null and c.portal_token is not null) as has_portal,
              count(l.agent_id)::int as lead_count
         from orch_clients c
         left join orch_client_leads l on l.client_id = c.id
        ${inReviewOnly ? "where c.leads_inreview = true" : ""}
        group by c.id
        order by c.client_name nulls last`
    ),
    pool.query(`select max(fetched_at) as at from bison_campaigns`),
  ]);
  return NextResponse.json({ clients: rows, campaignsSyncedAt: sync.rows[0]?.at ?? null });
}
