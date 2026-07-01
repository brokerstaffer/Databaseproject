// Canonical agent ingest: upsert a batch of Courted-shaped rows into agents +
// agent_source_stats + offices + mls + junctions. Used by /api/ingest/agents
// (scraper webhook). Rows are keyed by the Courted CSV column names.
//
// BULK design: the whole batch is processed with a fixed, small number of
// set-based SQL statements (not ~5 queries per row), so throughput no longer
// depends on per-row round-trips to the (cross-region) DB. New rows get a
// client-generated UUID so inserts don't need RETURNING-order mapping.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const money = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const pct = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
};
const intval = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
const num = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const yn = (v: unknown): boolean | null => {
  const s = txt(v);
  if (s == null) return null;
  if (/^yes$/i.test(s)) return true;
  if (/^no$/i.test(s)) return false;
  return null;
};
const lower = (v: unknown): string | null => {
  const s = txt(v);
  return s == null ? null : s.toLowerCase();
};
const digits = (v: unknown): string | null => {
  const s = txt(v);
  return s == null ? null : s.replace(/[^0-9]/g, "");
};
const deriveTitle = (r: Row): string =>
  yn(r["Is Managing Broker"]) ? "Managing Broker" : yn(r["Is Team Leader"]) ? "Team Leader" : "Salesperson";

// "23 years 8 months of experience" / "22" -> months
function yearsToMos(raw: unknown): number | undefined {
  const s = txt(raw);
  if (!s) return undefined;
  const y = /(\d+)\s*year/i.exec(s);
  const m = /(\d+)\s*month/i.exec(s);
  if (!y && !m) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n * 12 : undefined;
  }
  return (y ? +y[1] : 0) * 12 + (m ? +m[1] : 0);
}
// "$756K" / "$1.2M" / "1,250,000" -> 756000 / 1200000 / 1250000
function expandMoney(raw: unknown): number | undefined {
  const s = txt(raw);
  if (!s) return undefined;
  const m = /([\d.]+)\s*([KkMmBb]?)/.exec(s.replace(/[$,]/g, ""));
  if (!m) return undefined;
  let n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === "K") n *= 1e3;
  else if (u === "M") n *= 1e6;
  else if (u === "B") n *= 1e9;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
// Translate a Realtor/Zillow row into the canonical Courted-style keys the upsert reads,
// so the scraper can POST each source's native columns. (Courted rows pass through.)
function remapRow(raw: Row, source: string): Row {
  if (source === "realtor") {
    return {
      "Name": raw["Name"], "First Name": raw["First Name"], "Last Name": raw["Last Name"],
      "State License": raw["License Number"],
      "Email": raw["Email"], "Phone": raw["Phone"], "Mobile Phone": raw["Mobile Phone"],
      "Office": raw["Office"],
      "Office City": raw["Office City"], "Office State": raw["Office State"], "Office Zip": raw["Office Postal"], "Office Address": raw["Office Address"],
      "Years Of Experience": raw["Years Of Experience"],
      "Agent Tenure (mos)": yearsToMos(raw["Years Of Experience"]),
      "Active Listings": raw["For Sale Count"],
      "Profile Photo URL": raw["Profile Photo URL"],
    };
  }
  if (source === "zillow") {
    return {
      "Name": raw["Name"],
      "State License": raw["License Number"],
      "Email": raw["Email"], "Phone": raw["Phone"],
      "Office": raw["Brokerage"], "Office Address": raw["Brokerage Address"],
      "Office City": raw["City"], "Office State": raw["State"], "Office Zip": raw["Zip Code"],
      "Years Of Experience": raw["Years of Experience"],
      "Agent Tenure (mos)": yearsToMos(raw["Years of Experience"]),
      "LTM Avg Sale Price": expandMoney(raw["Average Price"]),
      "LTM Closed Transactions": raw["Sales Count Last Year"],
      "Active Listings": raw["Active Listings Count"],
      "Profile Photo URL": raw["Profile Photo URL"],
    };
  }
  return raw; // courted: already canonical
}

function matchKey(license: string | null, email: string | null, phone: string | null, fullName: string | null, officeZip: string | null): [string, string] {
  if (license) return [`lic:${license.toLowerCase()}`, "high"];
  if (email) return [`email:${email.toLowerCase()}`, "high"];
  if (phone) return [`phone:${digits(phone)}`, "high"];
  return [`name:${(fullName || "").toLowerCase()}|${(officeZip || "").toLowerCase()}`, "low"];
}

// ---- column specs shared by insert + update (name must match the JS object keys) ----
const AGENT_COLS: [string, string][] = [
  ["full_name", "text"], ["first_name", "text"], ["last_name", "text"], ["license_number", "text"],
  ["preferred_email", "text"], ["preferred_phone", "text"], ["brand", "text"], ["office_name", "text"], ["office_id", "uuid"],
  ["est_time_in_industry_months", "numeric"], ["est_time_in_industry_raw", "text"],
  ["est_time_at_office_months", "numeric"], ["avg_time_at_office_months", "numeric"],
  ["home_city", "text"], ["home_zip", "text"], ["home_state", "text"], ["home_address", "text"],
  ["office_city", "text"], ["office_zip", "text"], ["office_state", "text"],
  ["most_transacted_city", "text"], ["most_transacted_zip", "text"], ["transacted_state", "text"],
  ["sales_volume", "numeric"], ["pct_change", "numeric"], ["buy_side_dollar", "numeric"], ["list_side_dollar", "numeric"],
  ["approx_gci", "numeric"], ["avg_sale_price", "numeric"], ["closed_transactions", "numeric"], ["units", "numeric"],
  ["buy_side_count", "numeric"], ["list_side_count", "numeric"], ["closed_rentals", "numeric"], ["avg_rental_price", "numeric"],
  ["active_listings", "integer"], ["pending_listings", "integer"], ["title", "text"],
  ["match_key", "text"], ["match_confidence", "text"],
];
const STAT_COLS: [string, string][] = [
  ["sales_volume", "numeric"], ["prev_sales_volume", "numeric"], ["pct_change", "numeric"], ["approx_gci", "numeric"],
  ["avg_sale_price", "numeric"], ["closed_transactions", "numeric"], ["units", "numeric"], ["buy_side_count", "numeric"],
  ["list_side_count", "numeric"], ["buy_side_dollar", "numeric"], ["list_side_dollar", "numeric"],
  ["avg_sale_price_buy_side", "numeric"], ["avg_sale_price_list_side", "numeric"], ["close_to_list_pct", "numeric"],
  ["avg_days_on_market", "integer"], ["closed_rentals", "numeric"], ["avg_rental_price", "numeric"],
];
const recordset = (cols: [string, string][], leadName: string, leadType: string) =>
  `${leadName} ${leadType}, ` + cols.map(([n, t]) => `${n} ${t}`).join(", ");

const OKEY = (brand: string | null, name: string | null, zip: string | null) => JSON.stringify([brand, name, zip]);

export interface IngestResult {
  inserted: number;
  updated: number;
  offices: number;
  mls: number;
}

interface Prepared {
  officeKey: string | null;
  officeName: string | null;
  brand: string | null;
  officeCity: string | null;
  officeState: string | null;
  officeZip: string | null;
  officeAddress: string | null;
  mlsCode: string | null;
  mlsName: string | null;
  mlsState: string | null;
  memberId: string | null;
  sid: string | null;
  license: string | null;
  email: string | null;
  phoneKey: string | null;
  agent: Record<string, unknown>;
  stat: Record<string, unknown>;
  courted: Record<string, unknown>;
}

export async function upsertAgentRows(client: PoolClient, rows: Row[], source: string): Promise<IngestResult> {
  const stats: IngestResult = { inserted: 0, updated: 0, offices: 0, mls: 0 };
  if (!rows.length) return stats;

  // ---- 1) prepare every row in JS (pure, no DB) ----
  const prepared: Prepared[] = rows.map((_raw) => {
    const r = remapRow(_raw, source);
    const brand = txt(r["Brand"]);
    const officeName = txt(r["Custom Office Name"]) || txt(r["Office"]);
    const officeCity = txt(r["Office City"]);
    const officeState = txt(r["Office State"]);
    const officeZip = txt(r["Office Zip"]);
    const officeAddress = txt(r["Office Address"]);
    const mlsCode = txt(r["MLS ID"]);
    const fullName = txt(r["Name"]);
    const license = txt(r["State License"]);
    const email = lower(r["Email"]);
    const phone = txt(r["Phone"]);
    const [mkey, mconf] = matchKey(license, email, phone, fullName, officeZip);

    const courtedRaw: Record<string, unknown> = {
      agent_id: txt(r["Courted Agent ID"]),
      id: txt(r["Courted ID"]),
      profile_url: txt(r["Courted Profile URL"]),
      profile_photo_url: txt(r["Profile Photo URL"]),
      nickname: txt(r["Nickname"]),
      mobile_phone: txt(r["Mobile Phone"]) && txt(r["Mobile Phone"]) !== phone ? txt(r["Mobile Phone"]) : undefined,
      is_new_agent: yn(r["Is New Agent"]),
      is_team_leader: yn(r["Is Team Leader"]),
      is_team_member: yn(r["Is Team Member"]),
      is_managing_broker: yn(r["Is Managing Broker"]),
      is_rental_agent: yn(r["Is Rental Agent"]),
      likelihood_to_move: txt(r["Likelihood To Move"]),
      future_growth_tag: txt(r["Future Growth Tag"]),
      forecast_segment: txt(r["Forecast Segment"]),
      ai_agent_type: txt(r["AI Agent Type"]),
      ytd_sales_volume: money(r["YTD Sales Volume"]),
      ytd_units: intval(r["YTD Units"]),
      ytd_avg_sale_price: money(r["YTD Avg Sale Price"]),
      alt_state_licenses: txt(r["Alt State Licenses"]),
    };
    const courted = Object.fromEntries(Object.entries(courtedRaw).filter(([, v]) => v !== undefined && v !== null));

    const agent: Record<string, unknown> = {
      full_name: fullName, first_name: txt(r["First Name"]), last_name: txt(r["Last Name"]),
      license_number: license, preferred_email: email, preferred_phone: phone,
      brand, office_name: officeName, office_id: null, // resolved below
      est_time_in_industry_months: num(r["Agent Tenure (mos)"]),
      est_time_in_industry_raw: txt(r["Years Of Experience"]),
      est_time_at_office_months: num(r["Time At Current Office (mos)"]),
      avg_time_at_office_months: num(r["Avg Time At Office (mos)"]),
      home_city: txt(r["Home City"]), home_zip: txt(r["Home Zip"]), home_state: txt(r["Home State"]), home_address: txt(r["Home Address"]),
      office_city: officeCity, office_zip: officeZip, office_state: officeState,
      most_transacted_city: txt(r["Most Transacted City"]), most_transacted_zip: txt(r["Most Transacted Zip"]), transacted_state: txt(r["Most Transacted State"]),
      sales_volume: money(r["LTM Sales Volume"]), pct_change: pct(r["Sales Volume Change %"]),
      buy_side_dollar: money(r["LTM Sales Volume Buy-Side"]), list_side_dollar: money(r["LTM Sales Volume List-Side"]),
      approx_gci: money(r["LTM Est GCI"]), avg_sale_price: money(r["LTM Avg Sale Price"]),
      closed_transactions: num(r["LTM Closed Transactions"]), units: num(r["LTM Closed Units"]),
      buy_side_count: num(r["LTM Units Buy-Side"]), list_side_count: num(r["LTM Units List-Side"]),
      closed_rentals: num(r["LTM Rental Count"]), avg_rental_price: money(r["LTM Avg Rental Price"]),
      active_listings: intval(r["Active Listings"]), pending_listings: intval(r["Pending Listings"]),
      title: deriveTitle(r), match_key: mkey, match_confidence: mconf,
    };
    const stat: Record<string, unknown> = {
      sales_volume: money(r["LTM Sales Volume"]), prev_sales_volume: money(r["Prev LTM Sales Volume"]), pct_change: pct(r["Sales Volume Change %"]),
      approx_gci: money(r["LTM Est GCI"]), avg_sale_price: money(r["LTM Avg Sale Price"]), closed_transactions: num(r["LTM Closed Transactions"]),
      units: num(r["LTM Closed Units"]), buy_side_count: num(r["LTM Units Buy-Side"]), list_side_count: num(r["LTM Units List-Side"]),
      buy_side_dollar: money(r["LTM Sales Volume Buy-Side"]), list_side_dollar: money(r["LTM Sales Volume List-Side"]),
      avg_sale_price_buy_side: money(r["LTM Avg Sale Price Buy-Side"]), avg_sale_price_list_side: money(r["LTM Avg Sale Price List-Side"]),
      close_to_list_pct: pct(r["LTM Close-To-List Price %"]), avg_days_on_market: intval(r["LTM Avg Days On Market"]),
      closed_rentals: num(r["LTM Rental Count"]), avg_rental_price: money(r["LTM Avg Rental Price"]),
    };

    return {
      officeKey: officeName || brand ? OKEY(brand, officeName, officeZip) : null,
      officeName, brand, officeCity, officeState, officeZip, officeAddress,
      mlsCode, mlsName: txt(r["MLS"]), mlsState: officeState || txt(r["Most Transacted State"]),
      memberId: txt(r["Member MLS ID"]),
      sid: txt(r["Courted ID"]), license, email, phoneKey: digits(phone),
      agent, stat, courted,
    };
  });

  await client.query("begin");
  try {
    // ---- 2) OFFICES (resolve every distinct office to an id) ----
    const officeIdByKey = new Map<string, string>();
    const officeByKey = new Map<string, Prepared>();
    for (const p of prepared) if (p.officeKey && !officeByKey.has(p.officeKey)) officeByKey.set(p.officeKey, p);
    if (officeByKey.size) {
      const keys = [...officeByKey.values()];
      const existing = await client.query(
        `select o.id, o.brand, o.office_name, o.office_zip
           from offices o
           join jsonb_to_recordset($1::jsonb) as v(brand text, name text, zip text)
             on o.brand is not distinct from v.brand and o.office_name is not distinct from v.name and o.office_zip is not distinct from v.zip`,
        [JSON.stringify(keys.map((k) => ({ brand: k.brand, name: k.officeName, zip: k.officeZip })))]
      );
      for (const row of existing.rows) officeIdByKey.set(OKEY(row.brand, row.office_name, row.office_zip), row.id);

      const missing = keys.filter((k) => !officeIdByKey.has(k.officeKey!));
      if (missing.length) {
        const toInsert = missing.map((k) => ({
          id: randomUUID(), brand: k.brand, office_name: k.officeName, office_city: k.officeCity,
          office_state: k.officeState, office_zip: k.officeZip, office_address: k.officeAddress,
        }));
        await client.query(
          `insert into offices (id, brand, office_name, office_city, office_state, office_zip, office_address, sources)
           select x.id, x.brand, x.office_name, x.office_city, x.office_state, x.office_zip, x.office_address, array[$2]::text[]
           from jsonb_to_recordset($1::jsonb) as x(id uuid, brand text, office_name text, office_city text, office_state text, office_zip text, office_address text)`,
          [JSON.stringify(toInsert), source]
        );
        for (const o of toInsert) officeIdByKey.set(OKEY(o.brand, o.office_name, o.office_zip), o.id);
        stats.offices = missing.length;
      }

      // enrich existing offices' location (new value wins, matching prior behaviour)
      const missingKeys = new Set(missing.map((k) => k.officeKey));
      const enrich = keys
        .filter((k) => !missingKeys.has(k.officeKey))
        .map((k) => ({ id: officeIdByKey.get(k.officeKey!), city: k.officeCity, state: k.officeState, address: k.officeAddress }))
        .filter((e) => e.id && (e.city || e.state || e.address));
      if (enrich.length) {
        await client.query(
          `update offices o set office_city = coalesce(x.city, o.office_city), office_state = coalesce(x.state, o.office_state), office_address = coalesce(x.address, o.office_address)
           from jsonb_to_recordset($1::jsonb) as x(id uuid, city text, state text, address text) where o.id = x.id`,
          [JSON.stringify(enrich)]
        );
      }
    }
    for (const p of prepared) p.agent.office_id = p.officeKey ? officeIdByKey.get(p.officeKey) ?? null : null;

    // ---- 3) MLS (upsert distinct codes -> id map) ----
    const mlsIdByCode = new Map<string, string>();
    const distinctMls = new Map<string, Prepared>();
    for (const p of prepared) if (p.mlsCode && !distinctMls.has(p.mlsCode)) distinctMls.set(p.mlsCode, p);
    if (distinctMls.size) {
      const res = await client.query(
        `insert into mls (code, name, state)
         select x.code, x.name, x.state from jsonb_to_recordset($1::jsonb) as x(code text, name text, state text)
         on conflict (code) do update set name = coalesce(excluded.name, mls.name), state = coalesce(excluded.state, mls.state)
         returning id, code`,
        [JSON.stringify([...distinctMls.values()].map((p) => ({ code: p.mlsCode, name: p.mlsName, state: p.mlsState })))]
      );
      for (const row of res.rows) mlsIdByCode.set(row.code, row.id);
      stats.mls = distinctMls.size;
    }

    // ---- 4) match existing agents in bulk (source-id -> license -> email -> phone) ----
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const bySid = new Map<string, string>(), byLic = new Map<string, string>(), byEmail = new Map<string, string>(), byPhone = new Map<string, string>();
    const sids = uniq(prepared.map((p) => p.sid));
    const lics = uniq(prepared.map((p) => p.license));
    const emails = uniq(prepared.map((p) => p.email));
    const phones = uniq(prepared.map((p) => p.phoneKey));
    if (sids.length) (await client.query(`select id, source_ids->$2->>'id' k from agents where source_ids->$2->>'id' = any($1::text[])`, [sids, source])).rows.forEach((r) => r.k != null && bySid.set(r.k, r.id));
    if (lics.length) (await client.query(`select id, license_number k from agents where license_number = any($1::text[])`, [lics])).rows.forEach((r) => byLic.set(r.k, r.id));
    if (emails.length) (await client.query(`select id, lower(preferred_email) k from agents where lower(preferred_email) = any($1::text[])`, [emails])).rows.forEach((r) => byEmail.set(r.k, r.id));
    if (phones.length) (await client.query(`select id, regexp_replace(coalesce(preferred_phone,''),'[^0-9]','','g') k from agents where regexp_replace(coalesce(preferred_phone,''),'[^0-9]','','g') = any($1::text[]) and regexp_replace(coalesce(preferred_phone,''),'[^0-9]','','g') <> ''`, [phones])).rows.forEach((r) => byPhone.set(r.k, r.id));

    // ---- 5) resolve each row to an agent id (in-batch dedup, order-sensitive; last row wins) ----
    const seen = new Map<string, string>(); // any identity key -> agent id already assigned in this batch
    const isNew = new Map<string, boolean>();
    const finalById = new Map<string, Prepared>();
    const statByAgent = new Map<string, Record<string, unknown>>();
    const agentMlsByPair = new Map<string, { agent_id: string; mls_id: string; mls_member_id: string | null }>();
    const officeMlsPairs = new Set<string>();
    for (const p of prepared) {
      const idkeys: string[] = [];
      if (p.sid) idkeys.push("s:" + p.sid);
      if (p.license) idkeys.push("l:" + p.license);
      if (p.email) idkeys.push("e:" + p.email);
      if (p.phoneKey) idkeys.push("p:" + p.phoneKey);

      // Resolve by tier in priority order (source-id -> license -> email -> phone). At EACH tier,
      // match against agents already assigned in this batch (seen) OR pre-existing ones (db maps),
      // so a higher tier always wins — a shared office phone can't override a license/email match.
      let agentId: string | undefined;
      if (p.sid) agentId = seen.get("s:" + p.sid) ?? bySid.get(p.sid);
      if (!agentId && p.license) agentId = seen.get("l:" + p.license) ?? byLic.get(p.license);
      if (!agentId && p.email) agentId = seen.get("e:" + p.email) ?? byEmail.get(p.email);
      if (!agentId && p.phoneKey) agentId = seen.get("p:" + p.phoneKey) ?? byPhone.get(p.phoneKey);
      if (!agentId) { agentId = randomUUID(); isNew.set(agentId, true); }
      for (const k of idkeys) seen.set(k, agentId);

      p.agent.id = agentId;
      finalById.set(agentId, p); // last row for this agent wins
      statByAgent.set(agentId, p.stat);
      const mlsId = p.mlsCode ? mlsIdByCode.get(p.mlsCode) : null;
      if (mlsId) {
        agentMlsByPair.set(`${agentId}|${mlsId}`, { agent_id: agentId, mls_id: mlsId, mls_member_id: p.memberId });
        if (p.agent.office_id) officeMlsPairs.add(`${p.agent.office_id}|${mlsId}`);
      }
    }

    // ---- 6) bulk insert new agents / bulk update matched agents ----
    const agentRecordset = recordset(AGENT_COLS, "id", "uuid");
    const agentSelect = ["x.id", ...AGENT_COLS.map(([n]) => `x.${n}`)].join(", ");
    const toAgentObj = (id: string, p: Prepared) => ({ id, ...p.agent, courted: p.courted });

    const insertRows = [...finalById.entries()].filter(([id]) => isNew.get(id)).map(([id, p]) => toAgentObj(id, p));
    const updateRows = [...finalById.entries()].filter(([id]) => !isNew.get(id)).map(([id, p]) => toAgentObj(id, p));
    stats.inserted = insertRows.length;
    stats.updated = updateRows.length;

    // offices an updated agent may be LEAVING (so their agent_count gets recomputed too)
    const recount = new Set<string>(officeIdByKey.values());
    if (updateRows.length) {
      const prevOffices = await client.query(
        `select distinct office_id from agents where id = any($1::uuid[]) and office_id is not null`,
        [updateRows.map((r) => r.id)]
      );
      for (const row of prevOffices.rows) recount.add(row.office_id);
    }

    if (insertRows.length) {
      await client.query(
        `insert into agents (id, ${AGENT_COLS.map(([n]) => n).join(", ")}, sources, source_ids)
         select ${agentSelect}, array[$2]::text[], jsonb_build_object($2, x.courted)
         from jsonb_to_recordset($1::jsonb) as x(${agentRecordset}, courted jsonb)`,
        [JSON.stringify(insertRows), source]
      );
    }
    if (updateRows.length) {
      const setClause = AGENT_COLS.map(([n]) => `${n} = x.${n}`).join(", ");
      await client.query(
        `update agents a set ${setClause},
           sources = (select array_agg(distinct s) from unnest(coalesce(a.sources, array[]::text[]) || array[$2]::text[]) s),
           source_ids = coalesce(a.source_ids, '{}'::jsonb) || jsonb_build_object($2, x.courted),
           updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(${agentRecordset}, courted jsonb) where a.id = x.id`,
        [JSON.stringify(updateRows), source]
      );
    }

    // ---- 7) agent_source_stats (one row per agent, this source) ----
    const statRows = [...statByAgent.entries()].map(([agent_id, s]) => ({ agent_id, ...s }));
    if (statRows.length) {
      await client.query(
        `insert into agent_source_stats (agent_id, source, ${STAT_COLS.map(([n]) => n).join(", ")}, scraped_at)
         select x.agent_id, $2, ${STAT_COLS.map(([n]) => `x.${n}`).join(", ")}, now()
         from jsonb_to_recordset($1::jsonb) as x(${recordset(STAT_COLS, "agent_id", "uuid")})
         on conflict (agent_id, source) do update set ${STAT_COLS.map(([n]) => `${n} = excluded.${n}`).join(", ")}, scraped_at = now()`,
        [JSON.stringify(statRows), source]
      );
    }

    // ---- 8) junctions ----
    const amls = [...agentMlsByPair.values()];
    if (amls.length) {
      await client.query(
        `insert into agent_mls (agent_id, mls_id, mls_member_id)
         select x.agent_id, x.mls_id, x.mls_member_id from jsonb_to_recordset($1::jsonb) as x(agent_id uuid, mls_id uuid, mls_member_id text)
         on conflict (agent_id, mls_id) do update set mls_member_id = excluded.mls_member_id`,
        [JSON.stringify(amls)]
      );
    }
    const omls = [...officeMlsPairs].map((s) => { const [office_id, mls_id] = s.split("|"); return { office_id, mls_id }; });
    if (omls.length) {
      await client.query(
        `insert into office_mls (office_id, mls_id)
         select x.office_id, x.mls_id from jsonb_to_recordset($1::jsonb) as x(office_id uuid, mls_id uuid) on conflict do nothing`,
        [JSON.stringify(omls)]
      );
    }

    // ---- 9) keep office.agent_count in sync for touched offices (incl. ones agents left) ----
    const touched = [...recount];
    if (touched.length) {
      await client.query(
        `update offices o set agent_count = (select count(*) from agents a where a.office_id = o.id) where o.id = any($1::uuid[])`,
        [touched]
      );
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
  return stats;
}
