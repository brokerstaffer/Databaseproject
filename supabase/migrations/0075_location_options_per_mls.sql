-- 0075: per-MLS location options (A15).
--
-- The Location filter offered every place in the database regardless of the MLS selected.
-- With ARMLS (Arizona) chosen it still listed Miami, Houston and Chicago — cities with zero
-- ARMLS agents — and the counts beside them were global, not scoped. Operators scrolled
-- 17,457 cities of which almost none were relevant.
--
-- Computing this live is not viable on this instance: a scoped aggregation for the largest
-- MLS (SOCAL, 127,856 agents) takes 11-12 s, because joining that many agents to the heap
-- costs ~4 GB of buffer traffic against a 1 GB shared_buffers. Neither the stored *_city_key
-- columns nor collapsing three scans into one LATERAL pass moved it. So it is precomputed,
-- exactly like location_options already is for the unscoped case.
--
-- SIZE/COST (measured): one pass builds all 53 MLSs x 4 levels in ~68 s and yields 127,677
-- rows / ~7 MB. Cheap to store, cheap to rebuild.
--
-- The table deliberately stores ONLY keys + counts, not display names. A place's display
-- name ("Miami, FL") does not depend on the MLS, so it is joined from location_options at
-- read time. Carrying the raw spellings through the aggregation is what pushed an earlier
-- version of this build past 2 minutes.
--
-- Counts are per (mls_id, place). Selecting several MLSs sums them, which double-counts an
-- agent who belongs to more than one of the selected MLSs (~12% of agents sit in 2+ MLSs).
-- The dropdown already presents its totals as approximate ("≈1,896,985 agents"), and these
-- counts guide selection rather than report a result, so the approximation is acceptable.
-- Exact multi-MLS counts would require live aggregation — the 11 s path this exists to avoid.

CREATE TABLE IF NOT EXISTS public.location_options_mls (
  mls_id      uuid    NOT NULL,
  field       text    NOT NULL,          -- 'city' | 'zip' | 'county' | 'state'
  key         text    NOT NULL,          -- match key, same shape as location_options.key
  state       text    NOT NULL DEFAULT '',
  agent_count integer NOT NULL,
  PRIMARY KEY (mls_id, field, key, state)
);

-- staging twin, so the visible table is only locked for the swap (same pattern as
-- location_options / location_options_stage)
CREATE TABLE IF NOT EXISTS public.location_options_mls_stage (
  LIKE public.location_options_mls INCLUDING ALL
);

-- the read path: "options for these MLSs at this level, biggest reach first"
CREATE INDEX IF NOT EXISTS idx_lom_mls_field
  ON public.location_options_mls (mls_id, field, agent_count DESC);

COMMENT ON TABLE public.location_options_mls IS
  'Per-MLS location filter options (A15). Keys + counts only; display names join from location_options. Rebuilt by fn_rebuild_location_options_mls().';
