import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// Shared row-gathering for both export paths (Send to Clay + CSV) so they can't drift.
// The export always produces AGENT rows. In Office mode it expands the chosen offices into
// every agent that belongs to them (agents.office_id), so you can target whole brokerages.

type GatherArgs = {
  mode?: string;
  source?: string;
  filters?: Record<string, unknown>;
  selectedIds?: unknown;
  rangeFrom?: unknown;
  rangeTo?: unknown;
};

// agent.* + its MLS affiliations (same shape the export columns expect).
const AGENT_SELECT = `
  select a.*,
    (select jsonb_agg(jsonb_build_object('code', m.code, 'member_id', am.mls_member_id))
       from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls
  from agents a`;

export async function gatherExportRows(args: GatherArgs): Promise<Record<string, unknown>[]> {
  const { mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo } = args;
  const from = Number(rangeFrom) > 0 ? Number(rangeFrom) : 1;
  const to = Number(rangeTo) > 0 ? Number(rangeTo) : null;
  const limit = to ? to - from + 1 : 100000;
  const offset = Math.max(from - 1, 0);
  const hasSelection = Array.isArray(selectedIds) && selectedIds.length > 0;

  // ---------- OFFICE MODE: chosen offices -> all of their agents ----------
  if (mode === "office") {
    let officeIds: string[];
    if (hasSelection) {
      officeIds = selectedIds as string[];
    } else {
      // no explicit selection -> every office matching the current filters (respecting range)
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("fn_filter_search", {
        p_mode: "office",
        p_source: source,
        p_filters: filters,
        p_sort_by: "sales_volume",
        p_sort_dir: "desc",
        p_limit: Math.min(limit, 100000),
        p_offset: offset,
      });
      if (error) throw new Error(error.message);
      officeIds = ((data?.data ?? []) as { id?: string }[]).map((o) => o.id!).filter(Boolean);
    }
    if (officeIds.length === 0) return [];
    // Bound the fan-out: an office can hold many agents, so cap total exported agents at 100k
    // (same ceiling agent mode uses) to avoid materializing an unbounded set / firing a POST per agent.
    const { rows } = await getPool().query(
      `${AGENT_SELECT} where a.office_id = any($1::uuid[]) order by a.sales_volume desc nulls last limit 100000`,
      [officeIds]
    );
    return rows as Record<string, unknown>[];
  }

  // ---------- AGENT MODE ----------
  if (hasSelection) {
    const { rows } = await getPool().query(
      `${AGENT_SELECT} where a.id = any($1::uuid[]) order by a.sales_volume desc nulls last`,
      [selectedIds as string[]]
    );
    return rows as Record<string, unknown>[];
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_filter_search", {
    p_mode: "agent",
    p_source: source,
    p_filters: filters,
    p_sort_by: "sales_volume",
    p_sort_dir: "desc",
    p_limit: Math.min(limit, 100000),
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  return (data?.data ?? []) as Record<string, unknown>[];
}
