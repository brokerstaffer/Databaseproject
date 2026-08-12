import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sanitizeSavedViews } from "@/lib/filters/sanitize-saved-views";

// Agent/Office search. Calls fn_filter_search (SECURITY DEFINER) -> { data, totalCount, salesVolumeTotal }.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      mode = "agent",
      source = "courted",
      sortBy = "sales_volume",
      sortDir = "desc",
      page = 1,
      pageSize = 50,
      filters = {},
    } = body ?? {};

    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    // saved-view include/exclude references are permission-gated to the caller's own/shared
    // views before they reach the SECURITY DEFINER RPC.
    //
    // The gate used to trigger on "savedViews" in filters, which is true on EVERY request --
    // the key is always present in the filter object, usually as {include: [], exclude: []}.
    // So every keystroke-debounced filter change paid a getUser() round-trip to Supabase Auth
    // before the query even started: latency on the critical path, and one more thing that can
    // stall. It now triggers only when a view is actually referenced.
    //
    // The permission check itself is unchanged: whenever ids ARE present they still go through
    // getUser() + sanitizeSavedViews, and an unauthenticated caller still gets them stripped.
    const sv = (filters as { savedViews?: { include?: unknown; exclude?: unknown } } | null)?.savedViews;
    const refCount =
      (Array.isArray(sv?.include) ? sv.include.length : 0) +
      (Array.isArray(sv?.exclude) ? sv.exclude.length : 0);

    let effFilters = filters;
    if (refCount > 0) {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      effFilters = await sanitizeSavedViews(filters, user?.id ?? null);
    } else if (sv) {
      // normalise the empty/malformed case without an auth round-trip
      effFilters = { ...filters, savedViews: { include: [], exclude: [] } };
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_filter_search", {
      p_mode: mode,
      p_source: source,
      p_filters: effFilters,
      p_sort_by: sortBy,
      p_sort_dir: sortDir,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.error("search RPC error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      data: data?.data ?? [],
      totalCount: data?.totalCount ?? 0,
      salesVolumeTotal: data?.salesVolumeTotal ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
