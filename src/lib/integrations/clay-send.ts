import { buildLabeledRow } from "@/lib/export/columns";

// Posts each agent to a client's Clay webhook as its own row. Shared by the initial send and
// the "Retry failed" action so behaviour can't drift.
//
// Rate limit: Clay's webhook allows 5 requests/second. We enforce that by spacing request
// STARTS at least ~215ms apart (a global gate), which keeps us safely under 5/sec even across
// concurrent workers and retries — instead of the old "fire 4 at once" approach that could
// burst above the limit. A worker pool provides just enough overlap to sustain the rate when
// Clay responds slowly. Failed rows return their agent id so the caller can retry only those.

export type ClaySendMeta = {
  clientName: string;
  campaignId: string | null;
  campaignName: string | null;
};

export type ClaySendResult = {
  sent: number;
  failed: number;
  failedIds: string[];
  statusCounts: Record<string, number>;
};

const CLAY_RATE_PER_SEC = 5;
// ~215ms between request starts: average ~4.6/sec, peak of 5 starts in any rolling 1s window
// (exactly Clay's ceiling). The retry/backoff below absorbs the rare boundary 429.
const MIN_START_INTERVAL_MS = Math.ceil(1000 / CLAY_RATE_PER_SEC) + 15;
const MAX_INFLIGHT = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendRowsToClay(
  webhookUrl: string,
  rows: Record<string, unknown>[],
  keys: string[],
  meta: ClaySendMeta
): Promise<ClaySendResult> {
  let sent = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const statusCounts: Record<string, number> = {};

  // Global start-time gate: hands out start slots spaced MIN_START_INTERVAL_MS apart.
  let nextStart = 0;
  async function rateGate() {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + MIN_START_INTERVAL_MS;
    const wait = start - now;
    if (wait > 0) await sleep(wait);
  }

  async function postOne(r: Record<string, unknown>): Promise<boolean> {
    const body = JSON.stringify({
      ...buildLabeledRow(r, keys),
      Client: meta.clientName,
      "Campaign Id": meta.campaignId,
      "Campaign Name": meta.campaignName,
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await rateGate(); // every attempt (incl. retries) counts against the 5/sec budget
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

  // Worker pool pulling from a shared cursor; the rate gate (not the pool size) sets the pace.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) break;
      const r = rows[i];
      const ok = await postOne(r);
      if (ok) {
        sent++;
      } else {
        failed++;
        if (r.id != null) failedIds.push(String(r.id)); // capture every failed agent so retry can recover it
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_INFLIGHT, rows.length) }, () => worker()));

  return { sent, failed, failedIds, statusCounts };
}

// "[statuses: 429×3, 500×1]" note for the audit log; "" when nothing to report.
export function statusNote(statusCounts: Record<string, number>): string {
  const keys = Object.keys(statusCounts);
  if (keys.length === 0) return "";
  return ` [statuses: ${Object.entries(statusCounts).map(([s, n]) => `${s}×${n}`).join(", ")}]`;
}
