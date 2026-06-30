import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { fetchClientCampaigns } from "@/lib/integrations/bison";

export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("x-cron-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (process.env.CRON_TOKEN && token === process.env.CRON_TOKEN) return true;
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
    return NextResponse.json({ ok: true, campaigns: camps.length });
  } catch (e) {
    return NextResponse.json({ ok: true, campaigns: 0, error: e instanceof Error ? e.message : "failed" });
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
