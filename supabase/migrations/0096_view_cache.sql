-- 0096: serve the unfiltered Location and MLS views from a precomputed snapshot.
--
-- These two views aggregate the whole agents table on every open, and nothing else in the app
-- is close to them. Measured on XL, no filters applied:
--
--     MLS view                                   4,441 ms
--     Location view  basis=office  state          3,255 ms
--                                  county         4,333 ms
--                                  city           3,614 ms
--     Location view  basis=all three  state      18,190 ms
--                                     county     23,405 ms
--                                     city       19,544 ms
--
-- The "all three" figures were not previously known -- the earlier measurements all used the
-- default office-only basis. Selecting all three bases expands every agent into three rows
-- (3.4M), deduplicates, and aggregates, twice over.
--
-- Rewriting was tried first and does not help. For the MLS view, replacing the sort-based
-- count(distinct office_id) with a two-pass hash aggregate: 3,207 -> 2,742 ms (verified
-- identical on all 53 rows). For the Location view, narrowing the six-column SELECT DISTINCT to
-- the identity columns and joining back for the metrics: 5,972 -> 6,250 ms, i.e. slightly
-- worse. The cost is the scan and the lateral expansion, not the formulation. Neither was worth
-- shipping.
--
-- What makes caching viable here is that the RESULTS are tiny -- 53 rows for the MLS view and
-- 58 to 17,859 for the Location view. So the whole grouped set is stored, not just one page,
-- and the reader still applies its own sort, limit and offset. Paging and column sorting stay
-- exactly as they are; only the aggregation is reused.
--
-- WHAT IS AND IS NOT CACHED
--   * Only the UNFILTERED view. The moment any filter is applied, the live query runs exactly
--     as before -- the eligibility test is an exact string comparison of the generated WHERE
--     against the no-filter WHERE for that source, so there is no way for a filtered request to
--     read a cached row.
--   * Only the combinations the cron populates. Anything else falls through to the live query.
--   * If the cache is empty, stale beyond its window, or the table is missing, the live query
--     runs. Nothing is removed and there is no path where a miss returns wrong or empty data.
--
-- THE TRADE-OFF, stated plainly: with no filters applied, the counts in these two views are as
-- of the last refresh rather than the current second. The refresh runs every 15 minutes. The
-- scraper adds a few hundred agents a day against 1.13M, so the visible difference is in the
-- tens of rows. Every filtered view stays exactly live. To turn this off entirely, unschedule
-- the cron job and truncate perf_view_rows -- the views revert to their current behaviour with
-- no code change.

CREATE TABLE IF NOT EXISTS public.perf_view_rows (
  key       text   NOT NULL,
  row_data  jsonb  NOT NULL,
  -- typed copies of the sortable columns so the reader can ORDER BY without unpacking jsonb
  s_label   text,
  s_agents  bigint,
  s_offices bigint,
  s_sales   numeric,
  s_units   numeric,
  s_updated text
);
CREATE INDEX IF NOT EXISTS idx_perf_view_rows_key ON public.perf_view_rows (key);

CREATE TABLE IF NOT EXISTS public.perf_view_meta (
  key          text PRIMARY KEY,
  total        bigint      NOT NULL,
  volume       numeric     NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.perf_view_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perf_view_meta ENABLE ROW LEVEL SECURITY;

-- The refresh calls fn_filter_search itself rather than duplicating the view SQL -- that keeps
-- one definition of what these views mean. perf.bypass tells the reader to skip the cache so
-- the refresh cannot read its own output.
CREATE OR REPLACE FUNCTION public.fn_refresh_perf_views()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '256MB'
AS $function$
declare
  v_src text; v_gran text; v_kind text; v_key text;
  v_filters jsonb; v_res jsonb; v_rows jsonb;
begin
  perform set_config('perf.bypass', 'on', true);

  -- MLS view, per source
  foreach v_src in array array['all', 'courted'] loop
    v_key := 'mls:' || v_src;
    v_res := fn_filter_search('mls', v_src, '{}'::jsonb, 'sales_volume', 'desc', 100000, 0);
    v_rows := v_res->'data';
    delete from perf_view_rows where key = v_key;
    insert into perf_view_rows (key, row_data, s_label, s_agents, s_offices, s_sales, s_units, s_updated)
      select v_key, d,
             d->>'label', (d->>'agents')::bigint, (d->>'offices')::bigint,
             (d->>'sales_volume')::numeric, (d->>'units')::numeric, d->>'updated'
        from jsonb_array_elements(v_rows) d;
    insert into perf_view_meta (key, total, volume, refreshed_at)
      values (v_key, (v_res->>'totalCount')::bigint, (v_res->>'salesVolumeTotal')::numeric, now())
      on conflict (key) do update set total = excluded.total, volume = excluded.volume, refreshed_at = now();
  end loop;

  -- Location view: the combinations the UI actually opens with, for the default source.
  -- Anything else keeps using the live query.
  foreach v_gran in array array['state', 'county', 'city'] loop
    foreach v_kind in array array['office', 'all'] loop
      v_key := 'location:all:' || v_gran || ':' || v_kind;
      v_filters := jsonb_build_object(
        'locGranularity', v_gran,
        'locKinds', case when v_kind = 'all'
                         then '["office","home","transacted"]'::jsonb
                         else '["office"]'::jsonb end);
      v_res := fn_filter_search('location', 'all', v_filters, 'sales_volume', 'desc', 100000, 0);
      v_rows := v_res->'data';
      delete from perf_view_rows where key = v_key;
      insert into perf_view_rows (key, row_data, s_label, s_agents, s_offices, s_sales, s_units, s_updated)
        select v_key, d,
               d->>'location', (d->>'agents')::bigint, (d->>'offices')::bigint,
               (d->>'sales_volume')::numeric, (d->>'units')::numeric, null
          from jsonb_array_elements(v_rows) d;
      insert into perf_view_meta (key, total, volume, refreshed_at)
        values (v_key, (v_res->>'totalCount')::bigint, (v_res->>'salesVolumeTotal')::numeric, now())
        on conflict (key) do update set total = excluded.total, volume = excluded.volume, refreshed_at = now();
    end loop;
  end loop;
end;
$function$;

-- Reader. Returns NULL when the request is not cache-eligible, so the caller falls through to
-- the live query. Sorting, limit and offset are applied here, against the stored grouped set.
CREATE OR REPLACE FUNCTION public.fn_perf_view_read(
  p_key text, p_sort_col text, p_sort_dir text, p_limit int, p_offset int
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare m record; v_data jsonb; v_col text; v_dir text;
begin
  if coalesce(current_setting('perf.bypass', true), '') = 'on' then return null; end if;

  select * into m from perf_view_meta where key = p_key and refreshed_at > now() - interval '2 hours';
  if not found then return null; end if;

  v_col := case p_sort_col
    when 'label' then 's_label' when 'location' then 's_label'
    when 'agents' then 's_agents' when 'offices' then 's_offices'
    when 'units' then 's_units' when 'updated' then 's_updated'
    else 's_sales' end;
  v_dir := case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end;

  execute format(
    'select coalesce(jsonb_agg(row_data order by %I %s nulls last, s_label asc), ''[]''::jsonb)
       from (select * from perf_view_rows where key = %L order by %I %s nulls last, s_label asc
              limit %s offset %s) t',
    v_col, v_dir, p_key, v_col, v_dir, p_limit, p_offset)
    into v_data;

  return jsonb_build_object('data', coalesce(v_data, '[]'::jsonb),
                            'totalCount', m.total, 'salesVolumeTotal', m.volume);
end;
$function$;

DO $sched$
BEGIN
  PERFORM cron.unschedule('perf-view-cache') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'perf-view-cache');
  PERFORM cron.schedule('perf-view-cache', '*/15 * * * *', 'select fn_refresh_perf_views()');
END $sched$;
