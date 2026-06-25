import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";

// Recent exports (CSV downloads + Clay sends), for the Export page.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ rows: [] });

  const { rows } = await getPool().query(
    "select id, action, performed_by, details, created_at from audit_logs where action in ('csv_export', 'clay_send') order by created_at desc limit 100"
  );
  return NextResponse.json({ rows });
}
