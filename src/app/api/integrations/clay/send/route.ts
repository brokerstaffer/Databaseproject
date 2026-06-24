import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

export const maxDuration = 300;

// Export -> Send to Clay: post the filtered (or selected) agents to a client's Clay webhook.
// Body: { clientId, campaignId?, campaignName?, mode?, source?, filters?, selectedIds?, rangeFrom?, rangeTo? }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { clientId, campaignId = null, campaignName = null, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo } = body ?? {};
  if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });

  const { data: client } = await supabase.from("clients").select("name, clay_webhook_url").eq("id", clientId).single();
  if (!client?.clay_webhook_url) return NextResponse.json({ error: "This client has no Clay webhook configured." }, { status: 400 });

  // ---- gather rows (bypasses RLS via SECURITY DEFINER RPC / pg pool) ----
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(selectedIds) && selectedIds.length > 0) {
    const { rows: r } = await getPool().query("select * from agents where id = any($1::uuid[]) order by sales_volume desc nulls last", [selectedIds]);
    rows = r;
  } else {
    const from = Number(rangeFrom) > 0 ? Number(rangeFrom) : 1;
    const to = Number(rangeTo) > 0 ? Number(rangeTo) : null;
    const limit = to ? to - from + 1 : 100000;
    const offset = from - 1;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_filter_search", {
      p_mode: mode,
      p_source: source,
      p_filters: filters,
      p_sort_by: "sales_volume",
      p_sort_dir: "desc",
      p_limit: Math.min(limit, 100000),
      p_offset: Math.max(offset, 0),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows = (data?.data ?? []) as Record<string, unknown>[];
  }

  if (rows.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });

  // ---- post to the client's Clay webhook in batches ----
  const BATCH = 500;
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(client.clay_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: client.name,
        campaign_id: campaignId,
        campaign_name: campaignName,
        batch_index: Math.floor(i / BATCH),
        count: batch.length,
        agents: batch,
      }),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Clay webhook returned ${res.status}`, sent }, { status: 502 });
    }
    sent += batch.length;
  }

  return NextResponse.json({ ok: true, sent, client: client.name });
}
