import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";

// Reverses a batch from PATCH /api/agents/contact.
//
//   POST /api/agents/contact/undo   { "batch_id": "..." }
//
// Restores the value each agent had before that batch touched it, and marks the entries undone
// so a second call cannot roll the value back further than where it started. Safe to retry.
//
// GET /api/agents/contact/undo?batch_id=... previews a batch without changing anything.
async function authed(req: NextRequest): Promise<boolean | string> {
  const token =
    req.headers.get("x-ingest-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return false;
  if (process.env.INGEST_TOKEN && token === process.env.INGEST_TOKEN) return "env-token";
  const { rows } = await getPool().query(
    "update api_keys set last_used_at = now() where key = $1 and revoked = false returning name",
    [token]
  );
  return rows.length > 0 ? (rows[0].name as string) : false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const batchId = new URL(req.url).searchParams.get("batch_id") ?? "";
  if (!UUID.test(batchId)) return NextResponse.json({ error: "bad batch_id" }, { status: 400 });

  const { rows } = await getPool().query(
    `select agent_id, field, old_value, new_value, matched_by, match_value, changed_by, changed_at, undone_at
       from agent_contact_history where batch_id = $1 order by changed_at limit 1000`,
    [batchId]
  );
  return NextResponse.json({
    batch_id: batchId,
    entries: rows.length,
    already_undone: rows.filter((r) => r.undone_at).length,
    changes: rows,
  });
}

export async function POST(req: NextRequest) {
  const who = await authed(req);
  if (!who) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const batchId = typeof body?.batch_id === "string" ? body.batch_id : "";
  if (!UUID.test(batchId)) return NextResponse.json({ error: "bad batch_id" }, { status: 400 });

  try {
    const { rows } = await getPool().query("select fn_undo_agent_contact($1::uuid) as r", [batchId]);
    const r = rows[0]?.r ?? { batch_id: batchId, restored: 0 };
    if ((r.restored ?? 0) > 0) {
      await logAudit({
        action: "agent_contact_undo",
        performedBy: typeof who === "string" ? who : "api",
        details: `batch ${batchId}: restored ${r.restored} phone(s)`,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("agent contact undo error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "undo failed" }, { status: 500 });
  }
}
