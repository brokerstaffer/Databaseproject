import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Typeahead options for the Location / Office Search / MLS filters.
// Location options come back as objects {v, n, var} with live totals (precomputed
// location_options table — instant, agent-count ordered); other types stay string arrays.
// scope=office limits location options to office locations (A8 — the Office view).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "";
  const field = searchParams.get("field");
  const q = searchParams.get("q") ?? "";
  const scope = searchParams.get("scope") === "office" ? "office" : "agent";

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_search_options", { p_type: type, p_field: field, p_q: q, p_scope: scope });
  if (error) {
    console.error("options RPC error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (type === "location" && data && !Array.isArray(data)) {
    return NextResponse.json(data); // {options: [{v,n,var}], total, agents}
  }
  return NextResponse.json({ options: data ?? [] });
}
