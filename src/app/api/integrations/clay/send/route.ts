import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";
import { orderedKeys, buildLabeledRow } from "@/lib/export/columns";
import { gatherExportRows } from "@/lib/export/gather-rows";

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
  const webhookUrl: string = client.clay_webhook_url;
  const clientName: string = client.name ?? "";

  // ---- gather AGENT rows (Office mode -> every agent in the chosen offices) ----
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }

  if (rows.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });

  // ---- post EACH agent to the client's Clay webhook as its own row ----
  // Clay creates one row per webhook request. Clay rate-limits bursts, so we use gentle
  // concurrency + retry-with-backoff on 429/5xx so rows aren't dropped.
  const CONCURRENCY = 4;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let sent = 0;
  let failed = 0;
  const statusCounts: Record<string, number> = {};

  async function postOne(r: Record<string, unknown>): Promise<boolean> {
    const body = JSON.stringify({
      ...buildLabeledRow(r, keys),
      Client: clientName,
      "Campaign Id": campaignId,
      "Campaign Name": campaignName,
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.ok) return true;
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        if (res.status === 429 || res.status >= 500) {
          await sleep(500 * 2 ** attempt); // 0.5s, 1s, 2s, 4s
          continue;
        }
        return false; // other 4xx — don't retry
      } catch {
        await sleep(500 * 2 ** attempt);
      }
    }
    return false;
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const oks = await Promise.all(chunk.map((r) => postOne(r as Record<string, unknown>)));
    sent += oks.filter(Boolean).length;
    failed += oks.filter((ok) => !ok).length;
    if (i + CONCURRENCY < rows.length) await sleep(150); // gentle throttle between batches
  }
  const statusNote = Object.keys(statusCounts).length ? ` [statuses: ${Object.entries(statusCounts).map(([s, n]) => `${s}×${n}`).join(", ")}]` : "";

  if (sent === 0) return NextResponse.json({ error: `Clay webhook rejected all rows.${statusNote}`, failed }, { status: 502 });

  await logAudit({
    action: "clay_send",
    performedBy: user.email ?? null,
    details: `Sent ${sent} agents (one row each) to ${client.name}'s Clay${campaignName ? ` (campaign: ${campaignName})` : ""}${failed ? ` — ${failed} failed${statusNote}` : ""}`,
  });
  return NextResponse.json({ ok: true, sent, failed, client: client.name });
}
