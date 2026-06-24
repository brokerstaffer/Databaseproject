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

  const base = process.env.BISON_API_BASE || "https://app.outboundhero.co/api";
  const pool = getPool();
  const { rows: clients } = await pool.query("select id, name, bison_api_key from clients where bison_api_key is not null");

  const results: { client: string; campaigns?: number; error?: string }[] = [];
  for (const c of clients) {
    try {
      const camps = await fetchClientCampaigns(c.bison_api_key, base);
      for (const cm of camps) {
        await pool.query(
          `insert into bison_campaigns (client_id, bison_campaign_id, name, status, raw, fetched_at)
           values ($1,$2,$3,$4,$5::jsonb, now())
           on conflict (client_id, bison_campaign_id) do update set name=excluded.name, status=excluded.status, raw=excluded.raw, fetched_at=now()`,
          [c.id, cm.bison_campaign_id, cm.name, cm.status, JSON.stringify(cm.raw)]
        );
      }
      await pool.query("update clients set bison_synced_at=now() where id=$1", [c.id]);
      results.push({ client: c.name, campaigns: camps.length });
    } catch (e) {
      results.push({ client: c.name, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return NextResponse.json({ ok: true, clients: clients.length, results });
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
