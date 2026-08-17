import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { fetchCampaigns, fetchRepliedLeads } from "@/lib/integrations/instantly";
import { makeCampaignMatcher, instantlyPrefix } from "@/lib/bison/match-campaign";
import { logAudit } from "@/lib/api/log-audit";

export const maxDuration = 300;

// Mirrors Instantly's replied leads into instantly_replies, so the Replied column, filter and sort
// cover both providers. v_replied_agents (0106) unions this with the Bison flag; nothing in the UI
// needed changing.
//
// SCOPE: replies only. No bounce sweep, no campaign-membership mirror — has_bounced,
// campaign_count and client_campaigns still mean EmailBison alone.
//
// Runs INLINE, unlike bison-sync. That route defers to a fire-and-forget background call because a
// full membership mirror takes 10-15 minutes, longer than any HTTP client will wait. This sweep is
// ~40 pages at ~1.2 s = under a minute, comfortably inside maxDuration, so it returns a real
// summary instead of a 202 and an audit row you have to go and read.
function authorized(req: NextRequest): boolean {
  const token =
    req.headers.get("x-cron-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expect = process.env.CRON_TOKEN ?? "";
  // length is checked first because timingSafeEqual THROWS on unequal buffer lengths
  if (expect && token.length === expect.length && timingSafeEqual(Buffer.from(token), Buffer.from(expect))) {
    return true;
  }
  return false;
}

async function handle(req: NextRequest) {
  let ok = authorized(req);
  if (!ok) {
    // fallback: any logged-in user, so a manual "Sync" button works from the app
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    ok = !!user;
  }
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.INSTANTLY_API_KEY ?? "";
  if (!key) {
    return NextResponse.json(
      { ok: true, replies: 0, error: "No INSTANTLY_API_KEY set on this service." },
      { status: 200 }
    );
  }

  const pool = getPool();
  const warnings: string[] = [];

  // Session-scoped advisory lock on ONE dedicated connection held for the whole run. pool.query
  // would take the lock on one connection and "unlock" on another, which silently does nothing.
  const lockConn = await pool.connect();
  const lock = await lockConn.query("select pg_try_advisory_lock(hashtext('instantly-reply-sync')) as ok");
  if (!lock.rows[0].ok) {
    lockConn.release();
    return NextResponse.json({ ok: true, skipped: true, note: "another Instantly sync is running" });
  }

  try {
    // 1. the replied sweep, and campaign names for attribution
    const replied = await fetchRepliedLeads(key);
    const campaigns = await fetchCampaigns(key);
    const campaignName = new Map(campaigns.map((c) => [c.campaign_id, c.name]));

    // 2. best-effort campaign -> client. Instantly names its campaigns
    // "Client Name (N) - Market - Market", not Bison's "Client + Sender + Market", so it needs its
    // own prefix rule; the scoring and the refusal to guess on a tie are shared.
    //
    // Most campaigns will NOT map, and that is expected rather than a failure: Instantly serves 87
    // distinct client prefixes across 313 campaigns while orch_clients holds 30. An unmapped
    // campaign still flags its agents as replied — only client_id is left null.
    const clients = (
      await pool.query("select id, client_name, bison_campaign_id from orch_clients where client_name is not null")
    ).rows as { id: string; client_name: string | null; bison_campaign_id: string | null }[];
    const matchCampaign = makeCampaignMatcher(clients, instantlyPrefix);

    // 3. resolve agents by email, same three tiers and the same precedence as bison-sync:118-139 —
    // preferred outranks enriched outranks agent-provided, each tier only filling what the
    // previous missed, `order by id` so an ambiguous address resolves deterministically.
    const emails = [...new Set(replied.map((r) => r.email))];
    const matched = new Map<string, string>();
    if (emails.length) {
      const tier = async (sql: string, list: string[]) => {
        if (!list.length) return;
        const { rows } = await pool.query(sql, [list]);
        for (const r of rows) if (r.e && !matched.has(r.e)) matched.set(r.e, r.id);
      };
      await tier("select id, lower(preferred_email) e from agents where lower(preferred_email) = any($1) order by id", emails);
      const rest = emails.filter((e) => !matched.has(e));
      await tier("select id, lower(enriched_email) e from agents where lower(enriched_email) = any($1) order by id", rest);
      const rest2 = emails.filter((e) => !matched.has(e));
      await tier(
        "select id, lower(source_ids->'agent_provided'->>'email') e from agents where lower(source_ids->'agent_provided'->>'email') = any($1) order by id",
        rest2
      );
    }

    // 4. empty-response guard, in the spirit of bison-sync:112-117 — an API blip must never clear
    // flags that are currently set
    const existing = (await pool.query("select count(*)::int n from instantly_replies")).rows[0].n as number;
    if (replied.length === 0 && existing > 0) {
      warnings.push(`empty replied sweep, kept ${existing} existing rows`);
      await logAudit({
        action: "instantly_reply_sync",
        performedBy: "cron",
        details: `SKIPPED: empty response, kept ${existing} rows — ${warnings.join("; ")}`,
      });
      return NextResponse.json({ ok: true, replies: 0, kept: existing, warnings });
    }

    // 5. replace the mirror in one transaction. The sweep is workspace-global, so unlike Bison
    // (which replaces per campaign) the whole table is the unit. The fetch already succeeded
    // before we get here, so a failed API call never reaches the delete.
    const rows = replied.map((r) => ({
      campaign_id: r.campaign_id ?? "",
      campaign_name: r.campaign_id ? campaignName.get(r.campaign_id) ?? null : null,
      client_id: r.campaign_id
        ? matchCampaign(campaignName.get(r.campaign_id) ?? null, r.campaign_id)?.id ?? null
        : null,
      email: r.email,
      agent_id: matched.get(r.email) ?? null,
      reply_count: r.reply_count,
      last_reply_at: r.last_reply_at,
    }));
    // the table is unique on (campaign_id, email); a lead can appear once per campaign
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      const k = `${r.campaign_id}|${r.email}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const dbc = await pool.connect();
    try {
      await dbc.query("begin");
      await dbc.query("delete from instantly_replies");
      if (deduped.length) {
        await dbc.query(
          `insert into instantly_replies (campaign_id, campaign_name, client_id, email, agent_id, reply_count, last_reply_at)
             select x.campaign_id, x.campaign_name, x.client_id, x.email, x.agent_id, x.reply_count, x.last_reply_at
               from jsonb_to_recordset($1::jsonb) as x(campaign_id text, campaign_name text, client_id uuid,
                                                       email text, agent_id uuid, reply_count int, last_reply_at timestamptz)`,
          [JSON.stringify(deduped)]
        );
      }
      await dbc.query("commit");
    } catch (e) {
      await dbc.query("rollback").catch(() => {});
      throw e;
    } finally {
      dbc.release();
    }

    const linked = deduped.filter((r) => r.agent_id).length;
    const attributed = deduped.filter((r) => r.client_id).length;
    const unmappedCampaigns = new Set(
      deduped.filter((r) => !r.client_id && r.campaign_id).map((r) => r.campaign_name ?? r.campaign_id)
    ).size;
    if (unmappedCampaigns) warnings.push(`${unmappedCampaigns} campaign(s) matched no client (replies still flagged)`);

    // bison-sync computes warnings[] and then throws them away (`void summary`), which is why no
    // audit row has ever recorded a sweep warning. Write them.
    await logAudit({
      action: "instantly_reply_sync",
      performedBy: "cron",
      details:
        `${deduped.length} replies, ${linked} linked to agents, ${attributed} attributed to a client` +
        (warnings.length ? ` — ${warnings.join("; ")}` : ""),
    });

    return NextResponse.json({
      ok: true,
      replies: deduped.length,
      linkedToAgents: linked,
      attributedToClient: attributed,
      warnings,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logAudit({ action: "instantly_reply_sync", performedBy: "cron", details: `FAILED: ${msg}` }).catch(() => {});
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtext('instantly-reply-sync'))").catch(() => {});
    lockConn.release();
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
