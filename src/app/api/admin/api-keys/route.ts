import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getPool } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/api/require-admin";
import { logAudit } from "@/lib/api/log-audit";

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "••••");

// List keys (masked).
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { rows } = await getPool().query(
    "select id, name, key, created_at, last_used_at, revoked from api_keys order by created_at desc"
  );
  const keys = rows.map((r) => ({
    id: r.id,
    name: r.name,
    masked: mask(r.key),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked: r.revoked,
  }));
  return NextResponse.json({ keys });
}

// Generate a new key — returns the full key ONCE.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await req.json().catch(() => ({}));
  if (!name || typeof name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
  const key = "bsk_" + randomBytes(24).toString("hex");
  const { rows } = await getPool().query(
    "insert into api_keys (name, key, created_by) values ($1, $2, $3) returning id",
    [name.trim(), key, admin.id]
  );
  await logAudit({ action: "api_key_created", performedBy: admin.email, details: `Created API key "${name.trim()}"` });
  return NextResponse.json({ id: rows[0].id, name: name.trim(), key });
}

// Revoke a key.
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { rows } = await getPool().query("update api_keys set revoked = true where id = $1 returning name", [id]);
  await logAudit({ action: "api_key_revoked", performedBy: admin.email, details: `Revoked API key "${rows[0]?.name ?? id}"` });
  return NextResponse.json({ ok: true });
}
