import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { fetchClientCampaigns, fetchCampaignLeads } from "@/lib/integrations/bison";

export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("x-cron-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expect = process.env.CRON_TOKEN ?? "";
  if (expect && token.length === expect.length && timingSafeEqual(Buffer.from(token), Buffer.from(expect))) return true;
  // Otherwise allow a logged-in user (the "Sync" button on the Webhooks page).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return !!user;
}

async function handle(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const base = process.env.BISON_API_BASE || "https://send.brokerstaffer.com/api";
  const pool = getPool();

  // All clients share ONE EmailBison workspace, so we pull every campaign once with a single key
  // (env BISON_API_KEY, else any stored client key — they're the same workspace) and associate to
  // clients later by campaign-name prefix ("Client Name + Sender + Market").
  const key =
    process.env.BISON_API_KEY ||
    (await pool.query("select bison_api_key from clients where bison_api_key is not null order by created_at limit 1")).rows[0]?.bison_api_key;
  if (!key) return NextResponse.json({ ok: true, campaigns: 0, error: "No EmailBison workspace key set." });

  try {
    const camps = await fetchClientCampaigns(key, base);
    for (const cm of camps) {
      await pool.query(
        `insert into bison_campaigns (bison_campaign_id, name, status, raw, fetched_at)
         values ($1,$2,$3,$4::jsonb, now())
         on conflict (bison_campaign_id) do update set name=excluded.name, status=excluded.status, raw=excluded.raw, fetched_at=now()`,
        [cm.bison_campaign_id, cm.name, cm.status, JSON.stringify(cm.raw)]
      );
    }
    await pool.query("update clients set bison_synced_at=now()");

    // ---- lead sync (detached): a full mirror takes 10-15 min — far longer than any HTTP
    // client waits. Running it inside the request dies with the connection (verified: two
    // aborted runs), so the handler kicks it off in the background and answers immediately;
    // completion/failure is recorded in audit_logs (action 'bison_lead_sync').
    void runLeadSync(pool, key, base).catch((e) => console.error("lead sync crashed:", e instanceof Error ? e.message : e));
    return NextResponse.json({ ok: true, campaigns: camps.length, leadSync: { started: true, note: "runs in background; see audit_logs action=bison_lead_sync" } }, { status: 202 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return NextResponse.json({ ok: false, campaigns: 0, error: msg }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runLeadSync(pool: any, key: string, base: string) {
    // ---- lead sync: mirror campaign membership into bison_client_leads (D1) ----
    // Campaign -> client mapping is FUZZY but ambiguity-safe: names are normalized (lowercase,
    // alphanumerics only, leading "the"/"copy of" dropped, whitespace collapsed) and a campaign
    // prefix maps to a client on exact equality or a >=6-char startsWith either way (numbered
    // variants "Elite Team 2", suffixed "Jeff Cook Real Estate LPT Realty", truncated client
    // names). Multiple candidates -> longest match wins; ties are left unmapped, never guessed.
    // Per campaign the row set is REPLACED atomically; a failed or suspicious fetch leaves the
    // previous rows untouched and is REPORTED (response + audit log).
    // advisory locks are SESSION-scoped: take and release them on one dedicated connection
    // held for the whole run (pool.query would lock on one connection and "unlock" on another)
    const lockConn = await pool.connect();
    const lock = await lockConn.query("select pg_try_advisory_lock(hashtext('bison-lead-sync')) as ok");
    if (!lock.rows[0].ok) {
      lockConn.release();
      console.log("lead sync skipped: another sync is already running");
      return;
    }
    try {
    const norm = (v: string) => v.toLowerCase().replace(/\bcopy of\b/g, "").replace(/[^a-z0-9]+/g, "").replace(/^the/, "");
    const clients = (await pool.query(
      "select id, client_name, bison_campaign_id from orch_clients where client_name is not null"
    )).rows as { id: string; client_name: string; bison_campaign_id: string | null }[];
    const byDirect = new Map(clients.filter((c) => c.bison_campaign_id).map((c) => [String(c.bison_campaign_id), c]));
    const normed = clients.map((c) => ({ c, n: norm(c.client_name) })).filter((x) => x.n.length >= 3);

    const mapCampaign = (name: string | null, bisonId: string) => {
      if (byDirect.has(bisonId)) return byDirect.get(bisonId)!;
      const prefix = (name ?? "").replace(/\s+/g, " ").split(" + ")[0].trim();
      const pn = norm(prefix);
      if (!pn) return null;
      let best: { c: (typeof clients)[number]; len: number; score: number } | null = null;
      let tied = false;
      for (const { c, n } of normed) {
        let score = 0;
        if (pn === n) score = 3;
        else if (n.length >= 6 && pn.startsWith(n)) score = 2;
        else if (pn.length >= 6 && n.startsWith(pn)) score = 1;
        if (!score) continue;
        if (!best || score > best.score || (score === best.score && n.length > best.len)) {
          best = { c, len: n.length, score };
          tied = false;
        } else if (score === best.score && n.length === best.len && c.id !== best.c.id) {
          tied = true;
        }
      }
      return best && !tied ? best.c : null;
    };

    const campRows = (await pool.query(
      "select coalesce(raw->>'id', bison_campaign_id) as bison_id, name from bison_campaigns"
    )).rows as { bison_id: string; name: string | null }[];

    let leadsTotal = 0, matchedTotal = 0, campaignsSynced = 0;
    const errors: { campaign: string; error: string }[] = [];
    const warnings: string[] = [];
    const unmappedClientLike: string[] = [];
    for (const cm of campRows) {
      const client = mapCampaign(cm.name, cm.bison_id);
      if (!client) {
        // the "Client + Sender + Market" shape marks real client campaigns; others are internal
        if ((cm.name ?? "").includes(" + ")) unmappedClientLike.push(cm.name!);
        continue;
      }
      try {
        const leads = await fetchCampaignLeads(key, base, cm.bison_id);
        const existing = (await pool.query(
          "select count(*)::int n from bison_client_leads where campaign_id = $1", [cm.bison_id]
        )).rows[0].n as number;
        if (leads.length === 0 && existing > 0) {
          // an empty response over previously-populated rows is more likely an API hiccup than
          // a genuinely emptied campaign — keep the old rows and surface it
          warnings.push(`${cm.name ?? cm.bison_id}: empty response, kept ${existing} existing rows`);
          continue;
        }
        const emails = [...new Set(leads.map((l) => l.email))];
        const matched = new Map<string, string>();
        if (emails.length) {
          // preferred email outranks enriched; order by id makes ambiguous emails deterministic
          const pref = await pool.query(
            "select id, lower(preferred_email) e from agents where lower(preferred_email) = any($1) order by id", [emails]);
          for (const r of pref.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          const rest = emails.filter((e) => !matched.has(e));
          if (rest.length) {
            const enr = await pool.query(
              "select id, lower(enriched_email) e from agents where lower(enriched_email) = any($1) order by id", [rest]);
            for (const r of enr.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          }
        }
        const dbc = await pool.connect();
        try {
          await dbc.query("begin");
          // a campaign belongs to exactly one client — a rename/re-point moves its rows
          await dbc.query("delete from bison_client_leads where campaign_id = $1", [cm.bison_id]);
          if (leads.length) {
            const seen = new Set<string>();
            const rows = leads.filter((l) => (seen.has(l.email) ? false : (seen.add(l.email), true)))
              .map((l) => ({ email: l.email, bison_lead_id: l.bison_lead_id, agent_id: matched.get(l.email) ?? null }));
            await dbc.query(
              `insert into bison_client_leads (client_id, campaign_id, campaign_name, bison_lead_id, email, agent_id)
               select $1, $2, $3, x.bison_lead_id, x.email, x.agent_id
                 from jsonb_to_recordset($4::jsonb) as x(bison_lead_id text, email text, agent_id uuid)`,
              [client.id, cm.bison_id, cm.name, JSON.stringify(rows)]
            );
            leadsTotal += rows.length;
            matchedTotal += rows.filter((r) => r.agent_id).length;
          }
          await dbc.query("commit");
          campaignsSynced++;
        } catch (e) {
          await dbc.query("rollback").catch(() => {});
          throw e;
        } finally {
          dbc.release();
        }
      } catch (e) {
        errors.push({ campaign: cm.name ?? cm.bison_id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // campaigns deleted from Bison entirely: their rows are no longer membership anywhere
    const liveIds = campRows.map((c) => c.bison_id);
    const purged = await pool.query(
      "delete from bison_client_leads where campaign_id <> all($1::text[])", [liveIds]
    );

    const summary = {
      campaignsSynced,
      leads: leadsTotal,
      matched: matchedTotal,
      errors,
      warnings,
      unmappedClientLike,
      purgedDeletedCampaignRows: purged.rowCount ?? 0,
    };
    await pool.query(
      `insert into audit_logs (action, performed_by, details) values ('bison_lead_sync', 'cron',
       $1)`,
      [`synced ${campaignsSynced} campaigns, ${leadsTotal} leads (${matchedTotal} matched)` +
       (errors.length ? ` — ${errors.length} FAILED: ${errors.map((e) => e.campaign).slice(0, 5).join(", ")}` : "") +
       (unmappedClientLike.length ? ` — unmapped: ${unmappedClientLike.slice(0, 5).join(", ")}` : "")]
    ).catch((e: unknown) => console.error("bison_lead_sync audit write failed:", e instanceof Error ? e.message : e));

    void summary; // recorded via the audit write above
    } finally {
      await lockConn.query("select pg_advisory_unlock(hashtext('bison-lead-sync'))").catch(() => {});
      lockConn.release();
    }
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
