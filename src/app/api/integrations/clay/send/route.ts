import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { orderedKeys, buildLabeledRow } from "@/lib/export/columns";

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
  const { clientId, campaignId = null, campaignName = null, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo, columns } = body ?? {};
  if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });
  const keys = orderedKeys(columns);

  const { data: client } = await supabase.from("clients").select("name, clay_webhook_url").eq("id", clientId).single();
  if (!client?.clay_webhook_url) return NextResponse.json({ error: "This client has no Clay webhook configured." }, { status: 400 });

  // ---- gather rows (bypasses RLS via SECURITY DEFINER RPC / pg pool) ----
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(selectedIds) && selectedIds.length > 0) {
    const { rows: r } = await getPool().query(
      `select a.*, (select jsonb_agg(jsonb_build_object('code', m.code, 'member_id', am.mls_member_id))
         from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls
       from agents a where a.id = any($1::uuid[]) order by a.sales_volume desc nulls last`,
      [selectedIds]
    );
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

  // ---- post EACH agent to the client's Clay webhook as its own row ----
  // Clay creates one row per webhook request, so we send one request per agent
  // (a few in parallel for speed). Each row carries the agent's columns + client/campaign.
  const CONCURRENCY = 10;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const oks = await Promise.all(
      chunk.map(async (r) => {
        try {
          const res = await fetch(client.clay_webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...buildLabeledRow(r as Record<string, unknown>, keys),
              Client: client.name,
              "Campaign Id": campaignId,
              "Campaign Name": campaignName,
            }),
          });
          return res.ok;
        } catch {
          return false;
        }
      })
    );
    sent += oks.filter(Boolean).length;
    failed += oks.filter((ok) => !ok).length;
  }

  if (sent === 0) return NextResponse.json({ error: "Clay webhook rejected all rows.", failed }, { status: 502 });

  await logAudit({
    action: "clay_send",
    performedBy: user.email ?? null,
    details: `Sent ${sent} agents (one row each) to ${client.name}'s Clay${campaignName ? ` (campaign: ${campaignName})` : ""}${failed ? ` — ${failed} failed` : ""}`,
  });
  return NextResponse.json({ ok: true, sent, failed, client: client.name });
}
