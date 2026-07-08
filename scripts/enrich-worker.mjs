// Enrichment worker — runs as its own Railway service (long-running, NOT a cron).
// Replaces the Clay table: claims queued enrichment_items, finds/verifies an email for each
// agent (steps replicated from the client's Clay table), caches the result on agents, then
// pushes finished leads into the chosen EmailBison campaign exactly the way Clay did
// (POST /api/leads with the workspace's custom variables, then attach-leads to the campaign).
//
// Concurrency/crash model (hardened after adversarial review):
//   * Every claim stamps a fresh claim_token; every write is fenced on that token, so an
//     overlapping worker (normal during Railway deploys) can reclaim stale items without the
//     old worker clobbering its state.
//   * bison_lead_id is persisted BEFORE attach so crash recovery never re-creates the lead.
//   * Graceful shutdown releases claimed-but-unprocessed items immediately.
//   * The enrichment cache on agents is only written by REAL enrichment steps — the testing
//     fallback never poisons it. not_found is only cached when every step ran cleanly.
//   * With no steps configured (and no fallback), the enrich stage doesn't claim at all —
//     items wait as 'pending' until the Clay steps land.
//
// Env:
//   DATABASE_URL                 required
//   BISON_API_KEY                workspace key (falls back to any clients.bison_api_key)
//   BISON_API_BASE               default https://send.brokerstaffer.com/api
//   BISON_RATE_PER_SEC           default 5
//   POLL_MS                      idle sleep between cycles, default 5000
//   CLAIM_BATCH                  items claimed per cycle, default 25
//   STALE_MIN                    reclaim items stuck in a transient status, default 60
//   BETTERENRICH_API_KEY         BetterEnrich (personal/work email finders)
//   INSTANTLY_API_KEY            Instantly (email verification)
//   OPENAI_API_KEY               "Claygent" web-research steps (LinkedIn + office domain)
//   USE_PREFERRED_EMAIL_FALLBACK "1" = use agents.preferred_email when provider keys are not
//                                set (testing only — result is NOT cached on agents)

import pg from "pg";
import { randomUUID } from "node:crypto";

const env = process.env;
const BASE = (env.BISON_API_BASE || "https://send.brokerstaffer.com/api").replace(/\/+$/, "");
const RATE = Math.max(1, Number(env.BISON_RATE_PER_SEC) || 5);
const POLL_MS = Number(env.POLL_MS) || 5000;
const CLAIM_BATCH = Math.min(100, Number(env.CLAIM_BATCH) || 25); // <=100 keeps one attach chunk per claim
const STALE_MIN = Number(env.STALE_MIN) || 60;
const MAX_ATTEMPTS = 3;
const FALLBACK = env.USE_PREFERRED_EMAIL_FALLBACK === "1";

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
pool.on("error", (e) => console.error("pg pool idle-client error:", e.message)); // never crash the loop

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; console.log("SIGTERM — releasing unprocessed items, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

// ---------------------------------------------------------------------------
// EmailBison client (same workspace/key the campaign sync uses)
// ---------------------------------------------------------------------------
let bisonKey = env.BISON_API_KEY || null;
async function getBisonKey() {
  if (bisonKey) return bisonKey;
  const { rows } = await pool.query(
    "select bison_api_key from clients where bison_api_key is not null order by created_at limit 1"
  );
  bisonKey = rows[0]?.bison_api_key ?? null;
  if (!bisonKey) throw new Error("No EmailBison API key (set BISON_API_KEY or store one on a client)");
  return bisonKey;
}

// Global rate gate: starts are spaced >= 1/RATE sec apart, shared by every Bison call.
let nextStart = 0;
async function rateGate() {
  const now = Date.now();
  const at = Math.max(now, nextStart);
  nextStart = at + Math.ceil(1000 / RATE) + 15;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function bison(method, path, body, attempt = 1) {
  await rateGate();
  const key = await getBisonKey();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return bison(method, path, body, attempt + 1);
    }
    throw new Error(`Bison ${method} ${path}: ${e instanceof Error ? e.message : "network error"}`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return bison(method, path, body, attempt + 1);
    }
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json?.data?.message || json?.message || text.slice(0, 200);
    const err = new Error(`Bison ${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.bisonMessage = msg;
    throw err;
  }
  return json;
}

// Find an existing lead by email (search matches full email; exact-match the result).
async function findBisonLeadByEmail(email, tries = 1) {
  for (let t = 0; t < tries; t++) {
    if (t > 0) await new Promise((r) => setTimeout(r, 2000)); // search indexing delay
    const found = await bison("GET", `/leads?search=${encodeURIComponent(email)}`);
    const hit = (found?.data ?? []).find((l) => (l.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Create-or-update by email (mirrors Clay's "Create or Update Lead" enrichment).
async function upsertBisonLead(payload) {
  try {
    const j = await bison("POST", "/leads", payload);
    const id = j?.data?.id ?? j?.id;
    if (id != null) return String(id);
    throw new Error("Bison POST /leads returned no lead id");
  } catch (e) {
    // Only a duplicate email means "find and update"; other 4xx are real validation errors.
    if (!/taken|already exists|duplicate/i.test(e.bisonMessage ?? e.message)) throw e;
  }
  const hit = await findBisonLeadByEmail(payload.email, 3);
  if (!hit) throw new Error(`Lead exists but could not be found by search: ${payload.email}`);
  await bison("PUT", `/leads/${hit.id}`, payload); // Clay's "PUT: replace all fields" behavior
  return String(hit.id);
}

// ---------------------------------------------------------------------------
// Client-scope dedup. Campaign naming convention: "Client Name + Sender + Market" —
// the prefix before the first " + " is the client. A lead already sitting in ANY of the
// same client's campaigns is skipped, not re-uploaded.
// ---------------------------------------------------------------------------
const clientPrefix = (name) => (name ?? "").split(" + ")[0].trim().toLowerCase();
const campaignNameCache = new Map(); // bison campaign id -> name

async function campaignNameById(id) {
  const key = String(id);
  if (campaignNameCache.has(key)) return campaignNameCache.get(key);
  // synced table first, Bison API for campaigns created since the last sync
  const { rows } = await pool.query(
    `select name from bison_campaigns where coalesce(raw->>'id', bison_campaign_id) = $1 limit 1`,
    [key]
  );
  let name = rows[0]?.name ?? null;
  if (!name) {
    try {
      const j = await bison("GET", `/campaigns/${key}`);
      name = j?.data?.name ?? null;
    } catch { /* unknown campaign: treat as no match */ }
  }
  campaignNameCache.set(key, name);
  return name;
}

// Returns the name of the same-client campaign the lead is already in, or null.
async function leadUsedByClient(lead, clientName) {
  const target = clientPrefix(clientName);
  if (!target) return null;
  for (const c of lead?.lead_campaign_data ?? []) {
    const name = await campaignNameById(c.campaign_id);
    if (name && clientPrefix(name) === target) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lead mapper — matches the Clay "Create or update lead" columns exactly (July 2026
// screenshots): 12 custom variables, sent on EVERY lead (empty string when unknown, so
// the variable always exists on the lead — Clay uses "PUT: replace all fields").
// ---------------------------------------------------------------------------
const money = (v) => (v == null || v === "" ? "" : `$${Math.round(Number(v)).toLocaleString("en-US")}`);
const num = (v) => (v == null ? "0" : String(v));
const cityState = (city, st) => (city ? (st ? `${city}, ${st}` : city) : "");
function profileUrl(sourceIds) {
  const s = sourceIds ?? {};
  return s.courted?.profile_url || s.realtor?.profile_url || s.zillow?.profile_url || "";
}
function splitName(full) {
  const parts = (full ?? "").trim().split(/\s+/);
  return { first: parts[0] || "Unknown", last: parts.slice(1).join(" ") || "-" };
}

export function mapAgentToBisonLead(agent, email, mlsCode) {
  const first = agent.first_name || splitName(agent.full_name).first;
  const last = agent.last_name || splitName(agent.full_name).last;
  const vars = [
    ["buy-side", money(agent.buy_side_dollar)],
    ["list-side", money(agent.list_side_dollar)],
    ["office city", cityState(agent.office_city, agent.office_state)],
    ["phone number", agent.preferred_phone ?? ""],
    ["sales volume", money(agent.sales_volume)],
    ["estimated gci", money(agent.approx_gci)],
    ["closed rentals", num(agent.closed_rentals)],
    ["courted profile", profileUrl(agent.source_ids)],
    ["mls affiliation", mlsCode ?? ""],
    ["top producing city", cityState(agent.most_transacted_city, agent.transacted_state)],
    ["average sales price", money(agent.avg_sale_price)],
    ["closed transactions", num(agent.closed_transactions)],
  ];
  return {
    first_name: first,
    last_name: last,
    email,
    company: agent.office_name || agent.brand || undefined,
    custom_variables: vars.map(([name, value]) => ({ name, value })),
  };
}

// ---------------------------------------------------------------------------
// Enrichment — the Clay-table replica lives in enrich-flow.mjs (both branches:
// "No Emails -> Enrich Both" and "FLOW: Both Emails -> Priority Pro -> Enrich Both").
// It runs when BETTERENRICH_API_KEY + INSTANTLY_API_KEY + OPENAI_API_KEY are set.
// ---------------------------------------------------------------------------
import { enrichAgent, providersConfigured } from "./enrich-flow.mjs";

// Returns { hit, cleanRun }. cleanRun = no step errored, so a null result is a trustworthy
// "no email exists" (cacheable) rather than a provider outage.
async function runEnrichment(agent, log) {
  if (providersConfigured()) {
    return enrichAgent(agent, log);
  }
  if (FALLBACK && agent.preferred_email) {
    log.push({ step: "preferred_email_fallback", ok: true, ms: 0, note: "testing fallback (not cached)" });
    return { hit: { email: agent.preferred_email, status: "unknown", provider: "preferred_email" }, cleanRun: true };
  }
  return { hit: null, cleanRun: false };
}

// ---------------------------------------------------------------------------
// Queue plumbing — every write is fenced on the claim_token taken at claim time.
// ---------------------------------------------------------------------------
async function reclaimStale() {
  await pool.query(
    `update enrichment_items set status = 'pending', claimed_at = null, claim_token = null, updated_at = now()
      where status = 'enriching' and claimed_at < now() - ($1 || ' minutes')::interval`,
    [STALE_MIN]
  );
  await pool.query(
    `update enrichment_items set status = 'enriched', claimed_at = null, claim_token = null, updated_at = now()
      where status = 'pushing' and claimed_at < now() - ($1 || ' minutes')::interval`,
    [STALE_MIN]
  );
}

async function claim(fromStatus, toStatus, extraWhere = "") {
  const token = randomUUID();
  const { rows } = await pool.query(
    `update enrichment_items i
        set status = $2, claimed_at = now(), claim_token = $4, updated_at = now()
      where i.id in (
        select e.id from enrichment_items e
          join enrichment_batches b on b.id = e.batch_id
         where e.status = $1 and b.status <> 'cancelled' ${extraWhere}
         order by e.created_at
         limit $3
         for update of e skip locked
      )
      returning i.*`,
    [fromStatus, toStatus, CLAIM_BATCH, token]
  );
  if (rows.length) {
    await pool.query(
      `update enrichment_batches set status = 'running' where status = 'queued' and id = any($1::uuid[])`,
      [[...new Set(rows.map((r) => r.batch_id))]]
    );
  }
  return { token, items: rows };
}

async function loadAgents(agentIds) {
  const { rows } = await pool.query(
    `select a.*, (select m.code from agent_mls am join mls m on m.id = am.mls_id
                   where am.agent_id = a.id limit 1) as mls_code
       from agents a where a.id = any($1::uuid[])`,
    [agentIds]
  );
  return new Map(rows.map((a) => [a.id, a]));
}

// Fenced write: no-op (returns false) if another worker has reclaimed the item since.
// Any write that releases the item (claimed_at -> null) also drops the fence token.
async function setItem(item, token, fields) {
  const releases = "claimed_at" in fields && fields.claimed_at === null;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const { rowCount } = await pool.query(
    `update enrichment_items set ${sets}${releases ? ", claim_token = null" : ""}, updated_at = now()
      where id = $1 and claim_token = $2`,
    [item.id, token, ...keys.map((k) => (k === "step_log" ? JSON.stringify(fields[k]) : fields[k]))]
  );
  if (rowCount === 0) console.warn(`lost claim on item ${item.id} — skipping write`);
  return rowCount > 0;
}

// transient failure -> retry from the given stable status; terminal after MAX_ATTEMPTS
async function failOrRetry(item, token, backTo, err, extraFields = {}) {
  const msg = err instanceof Error ? err.message : String(err);
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await setItem(item, token, { ...extraFields, status: "failed", attempts, error: msg, claimed_at: null });
  } else {
    await setItem(item, token, { ...extraFields, status: backTo, attempts, error: msg, claimed_at: null });
  }
}

// Release claimed-but-unprocessed items right away (shutdown / cancelled batch).
async function releaseItems(items, token, backTo) {
  if (items.length === 0) return;
  await pool.query(
    `update enrichment_items set status = $3, claimed_at = null, claim_token = null, updated_at = now()
      where id = any($1::uuid[]) and claim_token = $2`,
    [items.map((i) => i.id), token, backTo]
  );
}

// Refresh counters/finish-state of every active batch (self-heals batches whose final
// refresh was missed by a crash — cheap: the active-batch set is always tiny).
async function refreshActiveBatches() {
  await pool.query(
    `update enrichment_batches b set
        enriched = s.got_email,
        no_email = s.no_email,
        sent     = s.sent,
        failed   = s.failed,
        skipped  = s.skipped,
        status   = case when s.pending_work + (case when b.campaign_id is not null then s.awaiting_push else 0 end) = 0
                        then 'done' else b.status end,
        finished_at = case when s.pending_work + (case when b.campaign_id is not null then s.awaiting_push else 0 end) = 0
                           and b.finished_at is null then now() else b.finished_at end
       from (
         select batch_id,
                count(*) filter (where status in ('enriched','pushing','sent','skipped')) as got_email,
                count(*) filter (where status = 'no_email')                         as no_email,
                count(*) filter (where status = 'sent')                             as sent,
                count(*) filter (where status = 'failed')                           as failed,
                count(*) filter (where status = 'skipped')                          as skipped,
                count(*) filter (where status in ('pending','enriching','pushing')) as pending_work,
                count(*) filter (where status = 'enriched')                         as awaiting_push
           from enrichment_items
          where batch_id in (select id from enrichment_batches where status in ('queued','running'))
          group by batch_id
       ) s
      where b.id = s.batch_id and b.status in ('queued','running')`
  );
}

// ---------------------------------------------------------------------------
// Stage 1 — enrich: fresh cache read wins; otherwise run the step waterfall.
// With no steps configured (and no fallback), don't claim — items wait as 'pending'.
// ---------------------------------------------------------------------------
let warnedNoSteps = false;
async function enrichCycle() {
  if (!providersConfigured() && !FALLBACK) {
    if (!warnedNoSteps) { console.warn("enrichment provider keys not set — enrich stage idle, items stay pending"); warnedNoSteps = true; }
    return false;
  }
  const { token, items } = await claim("pending", "enriching");
  if (items.length === 0) return false;
  const agents = await loadAgents(items.map((i) => i.agent_id));

  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (shuttingDown) {
      await releaseItems(items.slice(n), token, "pending");
      break;
    }
    const agent = agents.get(item.agent_id);
    if (!agent) {
      await setItem(item, token, { status: "failed", error: "agent no longer exists", claimed_at: null });
      continue;
    }
    try {
      // Fresh cache read at use time: a sibling batch (or the other worker during a deploy)
      // may have enriched this same agent since our claim — never pay twice.
      const { rows: [cache] } = await pool.query(
        `select enriched_email, enriched_email_status, enriched_provider, enriched_at from agents where id = $1`,
        [agent.id]
      );
      if (cache?.enriched_at) {
        if (cache.enriched_email) {
          await setItem(item, token, {
            status: "enriched", attempts: 0, email: cache.enriched_email,
            email_status: cache.enriched_email_status, provider: cache.enriched_provider,
            step_log: [{ step: "cache", ok: true, ms: 0, note: "reused stored enrichment" }],
            error: null, claimed_at: null,
          });
        } else {
          await setItem(item, token, {
            status: "no_email", email_status: "not_found",
            step_log: [{ step: "cache", ok: true, ms: 0, note: "known not-found" }],
            error: null, claimed_at: null,
          });
        }
        continue;
      }

      const log = [];
      const { hit, cleanRun } = await runEnrichment(agent, log);
      if (hit) {
        // The testing fallback must NEVER write the permanent cache — only real steps do.
        if (hit.provider !== "preferred_email") {
          await pool.query(
            `update agents set enriched_email=$1, enriched_email_status=$2, enriched_provider=$3, enriched_at=now()
              where id=$4 and enriched_at is null`,
            [hit.email, hit.status, hit.provider, agent.id]
          );
        }
        await setItem(item, token, {
          status: "enriched", attempts: 0, email: hit.email, email_status: hit.status, provider: hit.provider,
          step_log: log, error: null, claimed_at: null,
        });
      } else if (providersConfigured() && cleanRun) {
        // every step ran cleanly and none found an email -> trustworthy not-found, cache it
        await pool.query(
          `update agents set enriched_email=null, enriched_email_status='not_found', enriched_provider=null, enriched_at=now()
            where id=$1 and enriched_at is null`,
          [agent.id]
        );
        await setItem(item, token, { status: "no_email", email_status: "not_found", step_log: log, error: null, claimed_at: null });
      } else if (providersConfigured()) {
        // one or more steps errored -> provider outage, not a real not-found: retry later
        await failOrRetry(item, token, "pending", new Error("enrichment step error (see step_log)"), { step_log: log });
      } else {
        // fallback mode with no preferred_email: terminal for this run, agents cache untouched
        await setItem(item, token, { status: "no_email", email_status: "not_found", step_log: log, error: null, claimed_at: null });
      }
    } catch (e) {
      await failOrRetry(item, token, "pending", e);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2 — push: create/update the Bison lead (id persisted BEFORE attach), then attach
// per campaign in chunks, marking each chunk 'sent' as soon as its attach succeeds.
// Only batches WITH a campaign reach this stage.
// ---------------------------------------------------------------------------
async function pushCycle() {
  const { token, items } = await claim("enriched", "pushing", "and b.campaign_id is not null");
  if (items.length === 0) return false;
  const agents = await loadAgents(items.map((i) => i.agent_id));
  const { rows: batches } = await pool.query(
    `select b.id, b.campaign_id, b.status,
            coalesce(c.name, split_part(b.campaign_name, ' + ', 1)) as client_name
       from enrichment_batches b left join clients c on c.id = b.client_id
      where b.id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.batch_id))]]
  );
  const batchOf = new Map(batches.map((b) => [b.id, b]));

  const toAttach = new Map(); // campaign_id -> [{item, leadId}]
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (shuttingDown) {
      await releaseItems(items.slice(n), token, "enriched");
      break;
    }
    const batch = batchOf.get(item.batch_id);
    if (!batch || batch.status === "cancelled") {
      await releaseItems([item], token, "enriched"); // batch cancelled mid-flight: don't push
      continue;
    }
    const agent = agents.get(item.agent_id);
    if (!agent || !item.email) {
      await setItem(item, token, { status: "failed", error: !agent ? "agent no longer exists" : "item has no email", claimed_at: null });
      continue;
    }
    try {
      const payload = mapAgentToBisonLead(agent, item.email, agent.mls_code);
      // Does this lead already exist in the workspace? (also our client-dedup source)
      const existing = await findBisonLeadByEmail(item.email);
      if (existing) {
        // CLIENT-SCOPE DEDUP: already in one of this client's campaigns -> don't re-upload.
        const usedIn = await leadUsedByClient(existing, batch.client_name);
        if (usedIn) {
          await setItem(item, token, {
            status: "skipped", bison_lead_id: String(existing.id),
            error: null, claimed_at: null,
            step_log: (item.step_log ?? []).concat([{ step: "client_dedup", ok: true, ms: 0, note: `already in "${usedIn}"` }]),
          });
          continue;
        }
      }
      // Crash recovery: reuse a previously-created lead id — never duplicate.
      let leadId = item.bison_lead_id ?? (existing ? String(existing.id) : null);
      if (existing) {
        await bison("PUT", `/leads/${existing.id}`, payload); // refresh data, Clay's PUT behavior
      } else if (!leadId) {
        leadId = await upsertBisonLead(payload);
      }
      await setItem(item, token, { bison_lead_id: leadId }); // persist BEFORE attach
      if (!toAttach.has(batch.campaign_id)) toAttach.set(batch.campaign_id, []);
      toAttach.get(batch.campaign_id).push({ item, leadId });
    } catch (e) {
      await failOrRetry(item, token, "enriched", e);
    }
  }

  for (const [campaignId, entries] of toAttach) {
    // per-chunk attach + per-chunk marking, so an already-attached chunk is never re-queued
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      try {
        await bison("POST", `/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: chunk.map((e) => e.leadId) });
        for (const { item, leadId } of chunk) {
          try {
            await setItem(item, token, { status: "sent", attempts: 0, bison_lead_id: leadId, error: null, claimed_at: null });
          } catch (e) {
            console.error(`mark-sent failed for item ${item.id}:`, e instanceof Error ? e.message : e);
          }
        }
      } catch (e) {
        for (const { item } of chunk) await failOrRetry(item, token, "enriched", e);
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
console.log(`enrich-worker up — rate ${RATE}/s, claim ${CLAIM_BATCH}, poll ${POLL_MS}ms, stale ${STALE_MIN}m, providers: ${providersConfigured()}, fallback: ${FALLBACK}`);
let lastStaleSweep = 0;
while (!shuttingDown) {
  try {
    if (Date.now() - lastStaleSweep > 60_000) {
      await reclaimStale();
      await refreshActiveBatches(); // self-heal batches stranded by a crash
      lastStaleSweep = Date.now();
    }
    const didEnrich = await enrichCycle();
    const didPush = await pushCycle();
    if (didEnrich || didPush) await refreshActiveBatches();
    else await new Promise((r) => setTimeout(r, POLL_MS));
  } catch (e) {
    console.error("cycle error:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
await pool.end();
console.log("enrich-worker stopped");
