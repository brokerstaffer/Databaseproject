// Import a Courted agent CSV into the Broker Staffer schema.
// Usage: node scripts/import-agents.mjs "/path/to/courted-agents.csv" [--source=courted] [--dry-run]
//
// Maps the 76-column Courted export per the verified field-mapping:
//  - offices upserted (dedupe brand+office_name+office_zip), mls upserted (by code),
//  - agents deduped via license -> email -> phone (+ source_ids.courted.id),
//  - agent_mls (mls_member_id), agent_source_stats(source), office_mls.
// States come straight from the CSV; counties left null (zip-derived later).
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });

const file = process.argv[2];
const DRY = process.argv.includes("--dry-run");
const SOURCE = (process.argv.find((a) => a.startsWith("--source=")) || "--source=courted").split("=")[1];
if (!file) {
  console.error('usage: node scripts/import-agents.mjs "<file.csv>" [--source=courted] [--dry-run]');
  process.exit(1);
}

// ---- parse helpers ----
const txt = (v) => { if (v == null) return null; const s = String(v).trim(); return s === "" ? null : s; };
const money = (v) => { const s = txt(v); if (s == null) return null; const n = parseFloat(s.replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
const pct = (v) => { const s = txt(v); if (s == null) return null; const n = parseFloat(s.replace(/%/g, "")); return Number.isFinite(n) ? n : null; };
const intval = (v) => { const s = txt(v); if (s == null) return null; const n = parseInt(s.replace(/,/g, ""), 10); return Number.isFinite(n) ? n : null; };
const num = (v) => { const s = txt(v); if (s == null) return null; const n = parseFloat(s.replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const yn = (v) => { const s = txt(v); if (s == null) return null; if (/^yes$/i.test(s)) return true; if (/^no$/i.test(s)) return false; return null; };
const lower = (v) => { const s = txt(v); return s == null ? null : s.toLowerCase(); };
const digits = (v) => { const s = txt(v); return s == null ? null : s.replace(/[^0-9]/g, ""); };
const deriveTitle = (r) => {
  if (yn(r["Is Managing Broker"])) return "Managing Broker";
  if (yn(r["Is Team Leader"])) return "Team Leader";
  return "Salesperson";
};

const rows = parse(readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, relax_quotes: true, bom: true });
console.log(`Parsed ${rows.length} rows from ${file} (source=${SOURCE}${DRY ? ", DRY RUN" : ""})`);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const stats = { offices: 0, mls: 0, inserted: 0, updated: 0 };
const officeCache = new Map();
const mlsCache = new Map();

function matchKey(license, email, phone, fullName, officeZip) {
  if (license) return [`lic:${license.toLowerCase()}`, "high"];
  if (email) return [`email:${email.toLowerCase()}`, "high"];
  if (phone) return [`phone:${digits(phone)}`, "high"];
  return [`name:${(fullName || "").toLowerCase()}|${(officeZip || "").toLowerCase()}`, "low"];
}

try {
  if (!DRY) await client.query("begin");

  for (const r of rows) {
    // ---------- office ----------
    const brand = txt(r["Brand"]);
    const officeName = txt(r["Custom Office Name"]) || txt(r["Office"]);
    const officeCity = txt(r["Office City"]);
    const officeState = txt(r["Office State"]);
    const officeZip = txt(r["Office Zip"]);
    const officeAddress = txt(r["Office Address"]);
    let officeId = null;
    if ((officeName || brand) && !DRY) {
      const ckey = `${brand || ""}|${officeName || ""}|${officeZip || ""}`;
      if (officeCache.has(ckey)) {
        officeId = officeCache.get(ckey);
      } else {
        const sel = await client.query(
          `select id from offices where brand is not distinct from $1 and office_name is not distinct from $2 and office_zip is not distinct from $3 limit 1`,
          [brand, officeName, officeZip]
        );
        if (sel.rows.length) {
          officeId = sel.rows[0].id;
          await client.query(
            `update offices set office_city=coalesce($2,office_city), office_state=coalesce($3,office_state), office_address=coalesce($4,office_address) where id=$1`,
            [officeId, officeCity, officeState, officeAddress]
          );
        } else {
          const ins = await client.query(
            `insert into offices (brand, office_name, office_city, office_state, office_zip, office_address, sources)
             values ($1,$2,$3,$4,$5,$6, array[$7]::text[]) returning id`,
            [brand, officeName, officeCity, officeState, officeZip, officeAddress, SOURCE]
          );
          officeId = ins.rows[0].id;
          stats.offices++;
        }
        officeCache.set(ckey, officeId);
      }
    }

    // ---------- mls ----------
    const mlsCode = txt(r["MLS ID"]);          // 'NABOR' (code)
    const mlsName = txt(r["MLS"]);             // 'Naples Area Board of Realtors' (name)
    const mlsState = officeState || txt(r["Most Transacted State"]);
    let mlsId = null;
    if (mlsCode && !DRY) {
      if (mlsCache.has(mlsCode)) {
        mlsId = mlsCache.get(mlsCode);
      } else {
        const ins = await client.query(
          `insert into mls (code, name, state) values ($1,$2,$3)
           on conflict (code) do update set name=coalesce(excluded.name, mls.name), state=coalesce(excluded.state, mls.state)
           returning id`,
          [mlsCode, mlsName, mlsState]
        );
        mlsId = ins.rows[0].id;
        mlsCache.set(mlsCode, mlsId);
        stats.mls++;
      }
    }

    // ---------- agent ----------
    const fullName = txt(r["Name"]);
    const license = txt(r["State License"]);
    const email = lower(r["Email"]);
    const phone = txt(r["Phone"]);
    const [mkey, mconf] = matchKey(license, email, phone, fullName, officeZip);

    const courted = {
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
      sales_volume_prediction: money(r["Sales Volume Prediction"]),
      prediction_low: money(r["Prediction Low"]),
      prediction_high: money(r["Prediction High"]),
      ytd_sales_volume: money(r["YTD Sales Volume"]),
      ytd_units: intval(r["YTD Units"]),
      ytd_avg_sale_price: money(r["YTD Avg Sale Price"]),
      alt_state_licenses: txt(r["Alt State Licenses"]),
    };
    const courtedClean = Object.fromEntries(Object.entries(courted).filter(([, v]) => v !== undefined && v !== null));

    const agentVals = {
      full_name: fullName,
      first_name: txt(r["First Name"]),
      last_name: txt(r["Last Name"]),
      license_number: license,
      preferred_email: email,
      preferred_phone: phone,
      brand,
      office_name: officeName,
      office_id: officeId,
      est_time_in_industry_months: num(r["Agent Tenure (mos)"]),
      est_time_in_industry_raw: txt(r["Years Of Experience"]),
      est_time_at_office_months: num(r["Time At Current Office (mos)"]),
      avg_time_at_office_months: num(r["Avg Time At Office (mos)"]),
      home_city: txt(r["Home City"]),
      home_zip: txt(r["Home Zip"]),
      home_state: txt(r["Home State"]),
      home_address: txt(r["Home Address"]),
      office_city: officeCity,
      office_zip: officeZip,
      office_state: officeState,
      most_transacted_city: txt(r["Most Transacted City"]),
      most_transacted_zip: txt(r["Most Transacted Zip"]),
      transacted_state: txt(r["Most Transacted State"]),
      sales_volume: money(r["LTM Sales Volume"]),
      pct_change: pct(r["Sales Volume Change %"]),
      buy_side_dollar: money(r["LTM Sales Volume Buy-Side"]),
      list_side_dollar: money(r["LTM Sales Volume List-Side"]),
      approx_gci: money(r["LTM Est GCI"]),
      avg_sale_price: money(r["LTM Avg Sale Price"]),
      closed_transactions: num(r["LTM Closed Transactions"]),
      units: num(r["LTM Closed Units"]),
      buy_side_count: num(r["LTM Units Buy-Side"]),
      list_side_count: num(r["LTM Units List-Side"]),
      closed_rentals: num(r["LTM Rental Count"]),
      avg_rental_price: money(r["LTM Avg Rental Price"]),
      active_listings: intval(r["Active Listings"]),
      pending_listings: intval(r["Pending Listings"]),
      title: deriveTitle(r),
      match_key: mkey,
      match_confidence: mconf,
    };

    if (DRY) continue;

    // dedupe waterfall: source_ids.courted.id -> license -> email -> phone
    const find = async (sql, p) => (await client.query(sql, p)).rows[0]?.id || null;
    let agentId = null;
    if (courtedClean.id) agentId = await find(`select id from agents where source_ids->'${SOURCE}'->>'id' = $1 limit 1`, [courtedClean.id]);
    if (!agentId && license) agentId = await find(`select id from agents where license_number = $1 limit 1`, [license]);
    if (!agentId && email) agentId = await find(`select id from agents where lower(preferred_email) = $1 limit 1`, [email]);
    if (!agentId && phone) agentId = await find(`select id from agents where regexp_replace(coalesce(preferred_phone,''),'[^0-9]','','g') = $1 and $1 <> '' limit 1`, [digits(phone)]);

    const cols = Object.keys(agentVals);
    const vals = cols.map((c) => agentVals[c]);
    if (agentId) {
      const set = cols.map((c, i) => `${c}=$${i + 2}`).join(", ");
      await client.query(
        `update agents set ${set},
           sources=(select array_agg(distinct s) from unnest(coalesce(sources, array[]::text[]) || array['${SOURCE}']::text[]) s),
           source_ids=coalesce(source_ids,'{}'::jsonb) || jsonb_build_object('${SOURCE}', $${cols.length + 2}::jsonb),
           updated_at=now()
         where id=$1`,
        [agentId, ...vals, JSON.stringify(courtedClean)]
      );
      stats.updated++;
    } else {
      const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
      const ins = await client.query(
        `insert into agents (${cols.join(", ")}, sources, source_ids)
         values (${ph}, array['${SOURCE}']::text[], jsonb_build_object('${SOURCE}', $${cols.length + 1}::jsonb)) returning id`,
        [...vals, JSON.stringify(courtedClean)]
      );
      agentId = ins.rows[0].id;
      stats.inserted++;
    }

    // agent_mls
    if (mlsId) {
      await client.query(
        `insert into agent_mls (agent_id, mls_id, mls_member_id) values ($1,$2,$3)
         on conflict (agent_id, mls_id) do update set mls_member_id=excluded.mls_member_id`,
        [agentId, mlsId, txt(r["Member MLS ID"])]
      );
    }

    // agent_source_stats
    await client.query(
      `insert into agent_source_stats
         (agent_id, source, sales_volume, prev_sales_volume, pct_change, approx_gci, avg_sale_price,
          closed_transactions, units, buy_side_count, list_side_count, buy_side_dollar, list_side_dollar,
          avg_sale_price_buy_side, avg_sale_price_list_side, close_to_list_pct, avg_days_on_market,
          closed_rentals, avg_rental_price, scraped_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       on conflict (agent_id, source) do update set
         sales_volume=excluded.sales_volume, prev_sales_volume=excluded.prev_sales_volume, pct_change=excluded.pct_change,
         approx_gci=excluded.approx_gci, avg_sale_price=excluded.avg_sale_price, closed_transactions=excluded.closed_transactions,
         units=excluded.units, buy_side_count=excluded.buy_side_count, list_side_count=excluded.list_side_count,
         buy_side_dollar=excluded.buy_side_dollar, list_side_dollar=excluded.list_side_dollar,
         avg_sale_price_buy_side=excluded.avg_sale_price_buy_side, avg_sale_price_list_side=excluded.avg_sale_price_list_side,
         close_to_list_pct=excluded.close_to_list_pct, avg_days_on_market=excluded.avg_days_on_market,
         closed_rentals=excluded.closed_rentals, avg_rental_price=excluded.avg_rental_price, scraped_at=now()`,
      [agentId, SOURCE,
       money(r["LTM Sales Volume"]), money(r["Prev LTM Sales Volume"]), pct(r["Sales Volume Change %"]),
       money(r["LTM Est GCI"]), money(r["LTM Avg Sale Price"]), num(r["LTM Closed Transactions"]),
       num(r["LTM Closed Units"]), num(r["LTM Units Buy-Side"]), num(r["LTM Units List-Side"]),
       money(r["LTM Sales Volume Buy-Side"]), money(r["LTM Sales Volume List-Side"]),
       money(r["LTM Avg Sale Price Buy-Side"]), money(r["LTM Avg Sale Price List-Side"]),
       pct(r["LTM Close-To-List Price %"]), intval(r["LTM Avg Days On Market"]),
       num(r["LTM Rental Count"]), money(r["LTM Avg Rental Price"])]
    );

    // office_mls
    if (officeId && mlsId) {
      await client.query(`insert into office_mls (office_id, mls_id) values ($1,$2) on conflict do nothing`, [officeId, mlsId]);
    }
  }

  if (!DRY) await client.query("commit");
  console.log("Import complete:", JSON.stringify(stats));
} catch (e) {
  if (!DRY) await client.query("rollback").catch(() => {});
  console.error("Import FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
