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
  const [{ rows }, sync, bisonTotal] = await Promise.all([
    pool.query(
      // lead_count = orchestrator/scraper list; bison_leads = what's actually in the sequencer
      // (all campaign membership, incl. leads not in our DB); bison_matched = of those, rows we
      // can show in the grid. Once bison_leads > 0 the client filter uses the Bison set (D1).
      `select c.id, c.client_name, c.status, c.mls, c.location, c.bison_campaign_id,
              c.leads_inreview, c.bison_leads_exported, c.created_at,
              (c.portal_url is not null and c.portal_token is not null) as has_portal,
              count(distinct l.agent_id)::int as lead_count,
              (select count(distinct b.email) from bison_client_leads b where b.client_id = c.id)::int as bison_leads,
              (select count(distinct b.agent_id) from bison_client_leads b where b.client_id = c.id and b.agent_id is not null)::int as bison_matched
         from orch_clients c
         left join orch_client_leads l on l.client_id = c.id
        ${inReviewOnly ? "where c.leads_inreview = true" : ""}
        group by c.id
        order by c.client_name nulls last`
    ),
    pool.query(`select max(fetched_at) as at from bison_campaigns`),
    pool.query(`select count(distinct (client_id, email))::int as total, count(distinct agent_id)::int as matched, max(synced_at) as at from bison_client_leads`),
  ]);
  return NextResponse.json({
    clients: rows,
    campaignsSyncedAt: sync.rows[0]?.at ?? null,
    bison: { total: bisonTotal.rows[0]?.total ?? 0, matched: bisonTotal.rows[0]?.matched ?? 0, syncedAt: bisonTotal.rows[0]?.at ?? null },
  });
}

// Manual "Add client" — normally the orchestrator creates clients at onboarding, but a client
// whose campaign already runs in Bison needs a row here before the sync can attach its leads.
// Name-only insert; the campaign matcher picks it up on the next sync. Blocks duplicates under
// the same normalization the matcher uses (case/spacing/punctuation-insensitive).
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (!name) return NextResponse.json({ error: "Client name is required" }, { status: 400 });

  const pool = getPool();
  const { rows: dupes } = await pool.query(
    `select client_name from orch_clients
      where regexp_replace(lower(client_name), '[^a-z0-9]', '', 'g') = regexp_replace(lower($1), '[^a-z0-9]', '', 'g')
      limit 1`,
    [name]
  );
  if (dupes.length) {
    return NextResponse.json({ error: `A client named "${dupes[0].client_name}" already exists` }, { status: 409 });
  }

  const { rows } = await pool.query(
    `insert into orch_clients (client_name, status) values ($1, 'new') returning id, client_name, status, created_at`,
    [name]
  );
  await pool.query(`insert into audit_logs (action, performed_by, details) values ('client_added', $1, $2)`, [
    user.email ?? user.id,
    `Added client "${name}" from the Clients page`,
  ]);
  return NextResponse.json({ client: rows[0] });
}
