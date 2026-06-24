import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_filter_search", {
      p_mode: mode,
      p_source: source,
      p_filters: filters,
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
