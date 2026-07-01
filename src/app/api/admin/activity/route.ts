import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/api/require-admin";

// Recent audit/activity entries for the Admin > Activity tab.
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { rows } = await getPool().query(
    "select id, action, performed_by, details, created_at, meta from audit_logs order by created_at desc limit 200"
  );
  return NextResponse.json({ activity: rows });
}
