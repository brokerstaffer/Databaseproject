import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Typeahead options for the Location / Office Search / MLS filters.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "";
  const field = searchParams.get("field");
  const q = searchParams.get("q") ?? "";

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_search_options", { p_type: type, p_field: field, p_q: q });
  if (error) {
    console.error("options RPC error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ options: data ?? [] });
}
