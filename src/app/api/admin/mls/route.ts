import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// Admin: list + edit MLS records. Editing the abbreviation (code) keeps the old code as an
// alias so the scraper's rows (matched by code) still resolve to the same MLS, and
// agents.primary_mls_code follows the rename.
const CODE_RE = /^[A-Za-z][A-Za-z0-9 &.\-]{1,19}$/; // same shape the ingest accepts

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin"].includes(profile.role)) return null;
  return user;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = await getPool().query(
    `select id, code, name, aliases, member_agents, to_char(bulk_refreshed_at, 'YYYY-MM-DD') as refreshed
       from mls order by member_agents desc nulls last, code`
  );
  return NextResponse.json({ mls: rows });
}

export async function PATCH(req: NextRequest) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if (!code && !name) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  if (code && !CODE_RE.test(code)) {
    return NextResponse.json({ error: "Abbreviation must be 2-20 letters/numbers (starting with a letter)" }, { status: 400 });
  }

  const pool = getPool();
  const cur = (await pool.query(`select code, name from mls where id = $1`, [id])).rows[0];
  if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (code && code !== cur.code) {
    // must not collide with any other MLS's code or aliases
    const clash = (
      await pool.query(`select code from mls where id <> $1 and (code = $2 or $2 = any(aliases)) limit 1`, [id, code])
    ).rows[0];
    if (clash) return NextResponse.json({ error: `"${code}" is already used by ${clash.code}` }, { status: 409 });
    await pool.query(
      `update mls set code = $2,
              aliases = (select array_agg(distinct a) from unnest(aliases || $3::text) a where a <> $2)
        where id = $1`,
      [id, code, cur.code]
    );
    // the grid label + campaign variable follow the rename
    await pool.query(`update agents set primary_mls_code = $2 where primary_mls_code = $1`, [cur.code, code]);
  }
  if (name && name !== cur.name) {
    await pool.query(`update mls set name = $2 where id = $1`, [id, name]);
  }
  await pool.query(`insert into audit_logs (action, performed_by, details) values ('mls_edited', $1, $2)`, [
    user.email ?? user.id,
    `MLS ${cur.code}: ${code && code !== cur.code ? `code -> ${code}` : ""} ${name && name !== cur.name ? `name -> "${name}"` : ""}`.trim(),
  ]);
  return NextResponse.json({ ok: true });
}
