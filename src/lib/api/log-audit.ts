import { getPool } from "@/lib/db/pool";

// Writes to audit_logs via the pg pool (bypasses RLS; reliable regardless of the
// service-role key). Best-effort: never throws into the caller.
export async function logAudit(params: {
  action: string;
  performedBy?: string | null;
  details?: string | null;
  meta?: unknown; // structured recovery data (e.g. a Clay send's failed agent ids)
}) {
  try {
    await getPool().query(
      "insert into audit_logs (action, performed_by, details, meta) values ($1, $2, $3, $4)",
      [params.action, params.performedBy ?? null, params.details ?? null, params.meta != null ? JSON.stringify(params.meta) : null]
    );
  } catch (e) {
    console.error("Audit log insert failed:", e instanceof Error ? e.message : e);
  }
}
