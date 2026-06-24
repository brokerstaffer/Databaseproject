import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Campaigns for a client (cached by the 6h Bison cron) — feeds the Export popup dropdown.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ campaigns: [] });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bison_campaigns")
    .select("id, bison_campaign_id, name, status")
    .eq("client_id", clientId)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaigns: data ?? [] });
}
