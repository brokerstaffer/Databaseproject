import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// A5: agent profile — identity + combined production + the per-MLS breakdown.
// mls rows join three sources: membership (agent_mls), that MLS's own production
// numbers (agent_mls_stats — fills as the 15-day refresh cycles run through the
// fixed ingest; null until that MLS re-scrapes), and the MLS's bulk-refresh date.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const pool = getPool();
  const [agentQ, mlsQ, sourceQ] = await Promise.all([
    pool.query(
      `select id, full_name, first_name, last_name, license_number, title, brand, office_name,
              preferred_email, enriched_email, preferred_phone, linkedin_url,
              home_city, home_state, home_zip, office_city, office_state, office_zip,
              most_transacted_city, est_time_in_industry_raw, est_time_in_industry_months,
              sales_volume, pct_change, buy_side_dollar, list_side_dollar, approx_gci,
              avg_sale_price, closed_transactions, units, buy_side_count, list_side_count,
              closed_rentals, avg_rental_price, mls_count, sources, updated_at
         from agents where id = $1`,
      [id]
    ),
    pool.query(
      `select m.code, m.name, am.mls_member_id,
              to_char(m.bulk_refreshed_at, 'YYYY-MM-DD') as mls_refreshed,
              s.sales_volume, s.pct_change, s.buy_side_dollar, s.list_side_dollar,
              s.approx_gci, s.avg_sale_price, s.closed_transactions, s.units,
              s.buy_side_count, s.list_side_count, s.closed_rentals, s.avg_rental_price,
              to_char(s.scraped_at, 'YYYY-MM-DD') as stats_as_of
         from agent_mls am
         join mls m on m.id = am.mls_id
         left join agent_mls_stats s on s.agent_id = am.agent_id and s.mls_id = am.mls_id
        where am.agent_id = $1
        order by s.sales_volume desc nulls last, m.code`,
      [id]
    ),
    pool.query(
      `select source, sales_volume, units, closed_transactions, avg_sale_price,
              to_char(scraped_at, 'YYYY-MM-DD') as scraped
         from agent_source_stats where agent_id = $1 order by source`,
      [id]
    ),
  ]);
  if (agentQ.rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ agent: agentQ.rows[0], mls: mlsQ.rows, sources: sourceQ.rows });
}
