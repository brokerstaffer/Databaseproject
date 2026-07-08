import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// Recent enrichment batches with live counters — feeds the Admin -> Activity progress panel.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await getPool().query(
    `select b.id, b.status, b.campaign_id, b.campaign_name, b.total, b.enriched, b.no_email,
            b.sent, b.failed, b.skipped, b.created_at, b.finished_at, c.name as client_name
       from enrichment_batches b
       left join clients c on c.id = b.client_id
      order by b.created_at desc
      limit 50`
  );
  return NextResponse.json({ batches: rows });
}
