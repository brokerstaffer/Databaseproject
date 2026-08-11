import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Typeahead options for the Location / Office Search / MLS filters.
// Location options come back as objects {v, n, var} with live totals (precomputed
// location_options table — instant, agent-count ordered); other types stay string arrays.
// scope=office limits location options to office locations (A8 — the Office view).
//
// A15: `mls` is a comma-separated list of selected MLS ids. When present, location options are
// scoped to those MLSs — only places their agents are actually in, counted within them. Ignored
// for non-location types and for office scope (the per-MLS table is agent-grained).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "";
  const field = searchParams.get("field");
  const q = searchParams.get("q") ?? "";
  const scope = searchParams.get("scope") === "office" ? "office" : "agent";
  // validated here so a malformed id can never reach the SECURITY DEFINER RPC as a uuid[] cast
  const mls = (searchParams.get("mls") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_search_options", {
    p_type: type,
    p_field: field,
    p_q: q,
    p_scope: scope,
    p_mls: mls.length ? mls : null,
  });
  if (error) {
    console.error("options RPC error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (type === "location" && data && !Array.isArray(data)) {
    return NextResponse.json(data); // {options: [{v,n,var}], total, agents}
  }
  return NextResponse.json({ options: data ?? [] });
}
