import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// Orchestrator clients (orch_clients, written by Masterinbox) + how many agents were built
// for each (orch_client_leads). Feeds the "Client" filter dropdown on the search screen.
// orch_* tables have no RLS grants for app users, so this reads via the pool behind an auth gate.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await getPool().query(
    `select c.id, c.client_name, c.status, count(l.agent_id)::int as lead_count
       from orch_clients c
       left join orch_client_leads l on l.client_id = c.id
      group by c.id
      order by c.client_name nulls last`
  );
  return NextResponse.json({ clients: rows });
}
