import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { makeCampaignMatcher } from "@/lib/bison/match-campaign";
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
    // B4 safety net: this route already runs every 6h (bison-cron), so piggyback the
    // saved-view recount here — covers direct-SQL data changes no API hook sees
    void pool.query("select fn_refresh_saved_list_counts()").catch(() => {});
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
    // norm/mapCampaign now come from @/lib/bison/match-campaign so this and the Export
    // dialog cannot drift apart again — that divergence hid 47 campaigns from 13 clients.
    const clients = (await pool.query(
      "select id, client_name, bison_campaign_id from orch_clients where client_name is not null"
    )).rows as { id: string; client_name: string; bison_campaign_id: string | null }[];
    const matchCampaign = makeCampaignMatcher(clients);

    const mapCampaign = (name: string | null, bisonId: string) => matchCampaign(name, bisonId);

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
          // agent-provided emails lead campaign sends since C3 — leads created with them
          // must map back to the same agent
          const rest2 = emails.filter((e) => !matched.has(e));
          if (rest2.length) {
            const prov = await pool.query(
              "select id, lower(source_ids->'agent_provided'->>'email') e from agents where lower(source_ids->'agent_provided'->>'email') = any($1) order by id", [rest2]);
            for (const r of prov.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          }
        }
        const dbc = await pool.connect();
        try {
          await dbc.query("begin");
          // Carry `replied`/`bounced` across the replace below.
          //
          // The replace re-creates every row for this campaign and both flags default to false,
          // but the sweeps that set them run only AFTER the whole campaign loop. Without this
          // carry-over the flags read false for the 10-15 minutes the mirror takes to rebuild, so
          // the Replied filter, column and sort silently under-report for the entire window --
          // measured live at 2,731 replied rows draining to 501 mid-sync before recovering.
          //
          // Bounced is worse than replied: its sweep goes incremental whenever ANY bounced row
          // survives the loop (a campaign that errored or returned empty keeps its rows), and an
          // incremental pass only ADDS flags. Bounces wiped by the replace are then never
          // restored. Carrying the flags keeps the mirror correct at every instant; the
          // end-of-run sweeps still reconcile in both directions, so nothing is pinned stale.
          // Looked up by EMAIL across the whole table, not just this campaign, because that is
          // what both sweeps mean by the flags: each matches `email = any(...)` with no campaign
          // scoping, so a reply or a bounce belongs to the address, not to one campaign's row.
          // 32,182 emails sit in more than one campaign here, and leads get moved between them,
          // so a per-campaign lookup would drop the flag every time that happened.
          const prev = emails.length
            ? await dbc.query(
                `select email, bool_or(replied) replied, bool_or(bounced) bounced
                   from bison_client_leads
                  where email = any($1::text[]) and (replied or bounced)
                  group by email`,
                [emails]
              )
            : { rows: [] };
          const prevFlags = new Map<string, { replied: boolean; bounced: boolean }>(
            (prev.rows as { email: string; replied: boolean; bounced: boolean }[]).map((r) => [
              r.email,
              { replied: r.replied, bounced: r.bounced },
            ])
          );
          // a campaign belongs to exactly one client — a rename/re-point moves its rows
          await dbc.query("delete from bison_client_leads where campaign_id = $1", [cm.bison_id]);
          if (leads.length) {
            const seen = new Set<string>();
            const rows = leads.filter((l) => (seen.has(l.email) ? false : (seen.add(l.email), true)))
              .map((l) => ({
                email: l.email,
                bison_lead_id: l.bison_lead_id,
                agent_id: matched.get(l.email) ?? null,
                replied: prevFlags.get(l.email)?.replied ?? false,
                bounced: prevFlags.get(l.email)?.bounced ?? false,
              }));
            await dbc.query(
              `insert into bison_client_leads (client_id, campaign_id, campaign_name, bison_lead_id, email, agent_id, replied, bounced)
               select $1, $2, $3, x.bison_lead_id, x.email, x.agent_id, x.replied, x.bounced
                 from jsonb_to_recordset($4::jsonb) as x(bison_lead_id text, email text, agent_id uuid, replied boolean, bounced boolean)`,
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

    // C4: which leads have EVER replied — one paginated sweep of the workspace-global
    // replied filter, then flag our mirrored rows.
    //
    // NOTE ON PAGE SIZE: this endpoint IGNORES per_page and serves 15 rows a page regardless, so
    // the old 500-page cap was 7,500 leads, not 50,000. At 3,755 replied leads today (251 pages)
    // that headroom was under 2x. Exceeding the cap did NOT throw -- the loop just ended -- and
    // the update below then CLEARED replied for every lead past the cut. Raised to the bounce
    // sweep's 2,000 and made incomplete pagination an error, because a truncated list must never
    // reach an UPDATE that treats absence as "no longer replied".
    let repliedTotal = 0;
    try {
      const repliedEmails: string[] = [];
      let complete = false;
      for (let page = 1; page <= 2000; page++) {
        const res = await fetch(
          `${base.replace(/\/+$/, "")}/leads?filters[lead_campaign_status]=replied&pagination_type=length_aware&per_page=100&page=${page}`,
          { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }
        );
        if (!res.ok) throw new Error(`replied sweep ${res.status}`);
        const j = await res.json();
        const data: { email?: string }[] = Array.isArray(j?.data) ? j.data : [];
        for (const l of data) {
          const e = String(l.email ?? "").trim().toLowerCase();
          if (e.includes("@")) repliedEmails.push(e);
        }
        const lastPage = j?.meta?.last_page as number | undefined;
        if (data.length === 0 || (lastPage && page >= lastPage)) { complete = true; break; }
        if (!lastPage && data.length >= 100) throw new Error("replied sweep: pagination shape unknown");
      }
      if (!complete) throw new Error("replied sweep: page cap hit — refusing to clear flags from a truncated list");
      repliedTotal = repliedEmails.length;
      await pool.query("update bison_client_leads set replied = (email = any($1::text[])) where replied is distinct from (email = any($1::text[]))", [repliedEmails]);
    } catch (e) {
      warnings.push(`replied sweep failed: ${e instanceof Error ? e.message : "error"}`);
    }

    // C1: bounced sweep — CURSOR pagination (the replies endpoint caps pages at 15 items
    // and offset pagination degrades to minutes-per-page at depth; cursors stay ~250ms).
    // Incremental: once flags exist, stop as soon as a page's items are all older than the
    // last completed sync minus a day — routine sweeps read only the new bounces.
    let bouncedTotal = 0;
    try {
      const hasFlags = ((await pool.query("select 1 from bison_client_leads where bounced limit 1")).rowCount ?? 0) > 0;
      const lastSync = (await pool.query("select max(created_at) t from audit_logs where action='bison_lead_sync'")).rows[0]?.t;
      const cutoff = hasFlags && lastSync ? new Date(new Date(lastSync).getTime() - 24 * 3600 * 1000) : null;
      const bouncedEmails: string[] = [];
      const root = base.replace(/\/+$/, "");
      let url = `${root}/replies?folder=bounced&pagination_type=cursor&per_page=100`;
      for (let i = 1; i <= 2000; i++) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`bounce sweep ${res.status}`);
        const j = await res.json();
        const data: { lead?: { email?: string } | null; primary_to_email_address?: string | null; created_at?: string }[] = Array.isArray(j?.data) ? j.data : [];
        let allOld = data.length > 0;
        for (const b of data) {
          const e = String(b.lead?.email ?? b.primary_to_email_address ?? "").trim().toLowerCase();
          if (e.includes("@")) bouncedEmails.push(e);
          if (!cutoff || !b.created_at || new Date(b.created_at) >= cutoff) allOld = false;
        }
        const next = j?.meta?.next_cursor ?? j?.next_cursor ?? j?.links?.next;
        if (!next || data.length === 0 || (cutoff && allOld)) break;
        // `links.next` comes back WITHOUT folder=bounced (verified against the live API), so
        // following it verbatim would page through every folder — and the full-reconcile branch
        // below would then flag replied leads as bounced. meta.next_cursor is a bare token today
        // and takes the safe path, but pull the cursor out of the URL rather than trusting that.
        const cursor = String(next).startsWith("http")
          ? new URL(String(next)).searchParams.get("cursor") ?? ""
          : String(next);
        if (!cursor) break;
        url = `${root}/replies?folder=bounced&pagination_type=cursor&per_page=100&cursor=${encodeURIComponent(cursor)}`;
      }
      bouncedTotal = bouncedEmails.length;
      if (cutoff) {
        // incremental pass: only ADD flags — clearing requires the full picture
        if (bouncedEmails.length) {
          await pool.query("update bison_client_leads set bounced = true where not bounced and email = any($1::text[])", [bouncedEmails]);
        }
      } else {
        await pool.query("update bison_client_leads set bounced = (email = any($1::text[])) where bounced is distinct from (email = any($1::text[]))", [bouncedEmails]);
      }
    } catch (e) {
      warnings.push(`bounce sweep failed: ${e instanceof Error ? e.message : "error"}`);
    }

    const summary = {
      campaignsSynced,
      leads: leadsTotal,
      matched: matchedTotal,
      replied: repliedTotal,
      bounced: bouncedTotal,
      errors,
      warnings,
      unmappedClientLike,
      purgedDeletedCampaignRows: purged.rowCount ?? 0,
    };
    await pool.query(
      `insert into audit_logs (action, performed_by, details) values ('bison_lead_sync', 'cron',
       $1)`,
      [`synced ${campaignsSynced} campaigns, ${leadsTotal} leads (${matchedTotal} matched), ` +
       `${repliedTotal} replied / ${bouncedTotal} bounced seen` +
       (errors.length ? ` — ${errors.length} FAILED: ${errors.map((e) => e.campaign).slice(0, 5).join(", ")}` : "") +
       // warnings used to be computed and dropped, which is why a failing sweep left no trace
       // anywhere: "replied sweep failed" and "bounce sweep failed" both land here, and both mean
       // the flags did not get reconciled on this run.
       (warnings.length ? ` — WARN: ${warnings.slice(0, 5).join("; ")}` : "") +
       (unmappedClientLike.length ? ` — unmapped: ${unmappedClientLike.slice(0, 5).join(", ")}` : "")]
    ).catch((e: unknown) => console.error("bison_lead_sync audit write failed:", e instanceof Error ? e.message : e));

    void summary; // the fields above are the ones worth persisting; the rest is for the HTTP body
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
