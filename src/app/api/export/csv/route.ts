import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { EXPORT_COLUMNS, EXPORT_VALUE, orderedKeys } from "@/lib/export/columns";

export const maxDuration = 300;

type Row = Record<string, unknown>;

const esc = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo, columns } = body ?? {};
  const keys = orderedKeys(columns);
  const labelByKey = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.key, c.label]));

  let rows: Row[] = [];
  if (Array.isArray(selectedIds) && selectedIds.length > 0) {
    const { rows: r } = await getPool().query(
      `select a.*, (select jsonb_agg(jsonb_build_object('code', m.code, 'member_id', am.mls_member_id))
         from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls
       from agents a where a.id = any($1::uuid[]) order by a.sales_volume desc nulls last`,
      [selectedIds]
    );
    rows = r;
  } else {
    const from = Number(rangeFrom) > 0 ? Number(rangeFrom) : 1;
    const to = Number(rangeTo) > 0 ? Number(rangeTo) : null;
    const limit = to ? to - from + 1 : 100000;
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_filter_search", {
      p_mode: mode,
      p_source: source,
      p_filters: filters,
      p_sort_by: "sales_volume",
      p_sort_dir: "desc",
      p_limit: Math.min(limit, 100000),
      p_offset: Math.max(from - 1, 0),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows = (data?.data ?? []) as Row[];
  }

  const header = keys.map((k) => esc(labelByKey[k])).join(",");
  const lines = rows.map((r) => keys.map((k) => esc(EXPORT_VALUE[k]?.(r))).join(","));
  const csv = [header, ...lines].join("\r\n");

  await logAudit({ action: "csv_export", performedBy: user.email ?? null, details: `Exported ${rows.length} agents to CSV (${keys.length} cols)` });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="broker-staffer-agents.csv"`,
    },
  });
}
