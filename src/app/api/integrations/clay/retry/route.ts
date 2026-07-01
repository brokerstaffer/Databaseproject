import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/api/require-admin";
import { gatherExportRows } from "@/lib/export/gather-rows";
import { sendRowsToClay, statusNote } from "@/lib/integrations/clay-send";

export const maxDuration = 300;

type SendMeta = {
  kind?: string;
  clientId?: string;
  campaignId?: string | null;
  campaignName?: string | null;
  source?: string;
  columns?: string[];
  failedIds?: string[];
  retried?: boolean;
};

// Retry a Clay send's FAILED agents only. Reads the recovery data stored on the audit log
// entry, re-sends exactly those agent ids (never the ones that already succeeded), marks the
// original entry as retried, and writes a fresh log line for the retry.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { logId } = (await req.json().catch(() => ({}))) ?? {};
  if (!logId) return NextResponse.json({ error: "logId required" }, { status: 400 });

  const { rows: logRows } = await getPool().query("select action, meta from audit_logs where id = $1", [logId]);
  const log = logRows[0];
  if (!log || log.action !== "clay_send") return NextResponse.json({ error: "Not a Clay send." }, { status: 404 });

  const meta = (log.meta ?? {}) as SendMeta;
  const failedIds = Array.isArray(meta.failedIds) ? meta.failedIds : [];
  if (meta.retried) return NextResponse.json({ error: "This send was already retried." }, { status: 400 });
  if (failedIds.length === 0) return NextResponse.json({ error: "No failed agents to retry." }, { status: 400 });
  if (!meta.clientId) return NextResponse.json({ error: "Missing client on this log entry." }, { status: 400 });

  // client + webhook
  const { rows: clientRows } = await getPool().query("select name, clay_webhook_url from clients where id = $1", [meta.clientId]);
  const client = clientRows[0];
  if (!client?.clay_webhook_url) return NextResponse.json({ error: "That client no longer has a Clay webhook." }, { status: 400 });

  // fetch ONLY the previously-failed agents
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode: "agent", source: meta.source ?? "courted", selectedIds: failedIds });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load agents" }, { status: 500 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "Those agents no longer exist." }, { status: 400 });

  // Claim the retry ATOMICALLY before sending: only one request can flip retried=false -> true.
  // A concurrent double-click loses the race here and aborts, so the failed set is never sent twice.
  const claim = await getPool().query(
    `update audit_logs set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('retried', true)
     where id = $1 and coalesce(meta->>'retried', 'false') <> 'true' returning id`,
    [logId]
  );
  if (claim.rowCount === 0) return NextResponse.json({ error: "This send is already being retried." }, { status: 409 });

  const keys = Array.isArray(meta.columns) && meta.columns.length ? meta.columns : Object.keys(rows[0]);
  const { sent, failed, failedIds: stillFailed, statusCounts } = await sendRowsToClay(client.clay_webhook_url as string, rows, keys, {
    clientName: (client.name as string) ?? "",
    campaignId: meta.campaignId ?? null,
    campaignName: meta.campaignName ?? null,
  });
  const note = statusNote(statusCounts);
  const missing = failedIds.length - rows.length; // agents deleted since the original send

  // Fresh log line carrying the still-failing set (itself retryable). Written with errors
  // surfaced (not best-effort) so a partial retry can never silently orphan its failures.
  const details = `Retry: re-sent ${sent} of ${rows.length} agent${rows.length === 1 ? "" : "s"} to ${client.name}'s Clay${
    missing > 0 ? ` (${missing} no longer exist)` : ""
  }${failed ? ` — ${failed} still failed${note}` : ""}`;
  const retryMeta = { kind: "clay_send", clientId: meta.clientId, campaignId: meta.campaignId ?? null, campaignName: meta.campaignName ?? null, source: meta.source ?? "courted", columns: keys, failedIds: stillFailed, retryOf: logId };
  try {
    await getPool().query("insert into audit_logs (action, performed_by, details, meta) values ($1, $2, $3, $4)", [
      "clay_send",
      admin.email,
      details,
      JSON.stringify(retryMeta),
    ]);
  } catch (e) {
    console.error("retry recovery log insert failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: true, sent, failed, stillFailed, warning: "Agents were sent, but the recovery log could not be written — save the stillFailed ids to retry manually." },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true, sent, failed, stillFailed });
}
