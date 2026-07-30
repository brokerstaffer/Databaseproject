import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { sanitizeSavedViews } from "@/lib/filters/sanitize-saved-views";

// Which MLSs appear in the current agent set — the send dialog offers only these as
// "MLS data to send". Body: { source?, filters?, selectedIds? }.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const source = body?.source === "zillow_realtor" || body?.source === "all" ? body.source : "courted";
  const filters = await sanitizeSavedViews((body?.filters ?? {}) as Record<string, unknown>, user.id);
  const selectedIds: string[] = Array.isArray(body?.selectedIds)
    ? body.selectedIds.filter((x: unknown) => typeof x === "string")
    : [];

  const { rows } = await getPool().query("select fn_mls_in_set($1, $2::jsonb, $3::uuid[]) as options", [
    source,
    JSON.stringify(filters),
    selectedIds.length ? selectedIds : null,
  ]);
  return NextResponse.json({ options: rows[0]?.options ?? [] });
}
