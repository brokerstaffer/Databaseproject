-- 0083: the top-bar search stops sorting 1.1M rows (Phase B).
--
-- The top-bar term is a FIND tool, not a filter: matches float to the top and everything else
-- keeps its place. That was expressed as an ORDER BY over a computed expression --
--     order by (full_name ilike '%john smith%') desc nulls last, sales_volume desc nulls last
-- which no index can satisfy, so every keystroke sorted all 1.13M rows. Measured 6.7 s
-- end-to-end through fn_filter_search; 1.35 s for the bare ordering alone.
--
-- Same answer, computed as bounded pieces instead. The rows fall into up to three groups --
-- matched / not matched / undecidable (the email form can be NULL when all three email columns
-- are NULL) -- and each group only needs its own first (offset + limit) rows:
--     matched     -> the ilike is index-assisted by the existing pg_trgm / lower(email) indexes
--     not matched -> walks the sales_volume index and stops as soon as it has enough
-- The pieces are then concatenated in group order, which reproduces the original ordering
-- exactly. Measured 1,354 ms -> 107 ms, and identical id lists at offsets 0, 20 and 100.
--
-- A STABLE TIEBREAKER WAS REQUIRED. The original ORDER BY has no final tiebreaker, and 21 of
-- the 37 agents matching "john smith" share sales_volume = 0, so the query is not even
-- deterministic against ITSELF -- two runs returned different 20-row sets. That also means
-- LIMIT/OFFSET paging could repeat or skip rows. Both forms now end in a.id, which makes the
-- result reproducible and lets the split be verified as identical. The scoped (A5) branch of
-- fn_filter_search already ordered by "..., a.id", so this matches existing behaviour there.
-- Which agents match is unchanged; only the order WITHIN a tie is now defined instead of
-- arbitrary.
--
-- Only the agent-grain data query is affected. The count is unchanged (the term never filtered,
-- so the total is the same either way), and fn_filter_ids -- used by exports, not interactive --
-- is deliberately left alone.

-- The match expression on its own, so the split and the ordering cannot drift apart.
-- Mirrors fn_agent_order's three forms exactly: email when the term contains '@', phone when it
-- has 7+ digits, name otherwise. NULL means "no term", i.e. take the ordinary path.
CREATE OR REPLACE FUNCTION public.fn_agent_match_expr(p_filters jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when coalesce(p_filters->>'nameQuery', '') = '' then null
    when position('@' in p_filters->>'nameQuery') > 0
      then format('(preferred_email ilike %1$L or enriched_email ilike %1$L or (source_ids->''agent_provided''->>''email'') ilike %1$L)',
                  '%' || (p_filters->>'nameQuery') || '%')
    when length(regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g')) >= 7
      then format('(preferred_phone_digits like %L)',
                  '%' || regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g') || '%')
    else format('(full_name ilike %L)', '%' || (p_filters->>'nameQuery') || '%')
  end;
$function$;

-- The plain sort column, without the relevance prefix. Same whitelist as fn_agent_order, which
-- is what keeps an arbitrary p_sort_by out of the generated SQL.
CREATE OR REPLACE FUNCTION public.fn_agent_sort_col(p_sort_by text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_sort_by
    when 'full_name' then 'full_name' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
    when 'closed_transactions' then 'closed_transactions' when 'est_time_in_industry_months' then 'est_time_in_industry_months'
    when 'license_number' then 'license_number' when 'title' then 'title' when 'office_name' then 'office_name'
    when 'est_time_at_office_months' then 'est_time_at_office_months' when 'avg_time_at_office_months' then 'avg_time_at_office_months'
    when 'approx_gci' then 'approx_gci' when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
    when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
    when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
    when 'pct_change' then 'pct_change' when 'home_city' then 'home_city' when 'home_zip' then 'home_zip'
    when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' when 'brand' then 'brand'
    when 'most_transacted_city' then 'most_transacted_city'
    when 'preferred_email' then 'preferred_email' when 'preferred_phone' then 'preferred_phone'
    when 'total_sales_all_time' then 'total_sales_all_time' when 'avg_price_all_time' then 'avg_price_all_time'
    when 'avg_sales_volume_all_time' then 'avg_sales_volume_all_time'
    when 'linkedin_url' then 'linkedin_url'
    when 'mls' then 'primary_mls_code'
    when 'enriched_at' then 'enriched_at'
    else 'sales_volume' end;
$function$;

-- Returns the page of agent ids IN ORDER, using the split when a search term is present.
-- Kept separate from fn_filter_search so the row-shaping query stays untouched: it simply
-- joins these ids back with ordinality.
CREATE OR REPLACE FUNCTION public.fn_agent_page_ids(
  p_source text, p_filters jsonb, p_sort_by text, p_sort_dir text, p_limit int, p_offset int
)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_where text := fn_agent_where(p_source, p_filters);
  v_match text := fn_agent_match_expr(p_filters);
  v_col   text := fn_agent_sort_col(p_sort_by);
  v_dir   text := case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end;
  v_take  int  := p_limit + p_offset;   -- each group only ever needs this many
  v_ids   uuid[];
begin
  if v_match is null then
    -- no search term: ordinary ordered page, with the tiebreaker for stable paging
    execute format('select array_agg(id order by ord) from (select id, row_number() over () ord from (select a.id from agents a where %s order by a.%I %s nulls last, a.id limit %s offset %s) z) w',
                   v_where, v_col, v_dir, p_limit, p_offset)
      into v_ids;
    return coalesce(v_ids, '{}');
  end if;

  -- three bounded groups, concatenated in group order == the original relevance ordering
  execute format($q$
    select array_agg(id order by rn) from (
      select id, row_number() over (order by g, sk %2$s nulls last, id) rn
        from (
          (select a.id, a.%1$I sk, 0 g from agents a where (%3$s) and (%4$s)          order by a.%1$I %2$s nulls last, a.id limit %5$s)
          union all
          (select a.id, a.%1$I sk, 1 g from agents a where (%3$s) and not (%4$s)      order by a.%1$I %2$s nulls last, a.id limit %5$s)
          union all
          (select a.id, a.%1$I sk, 2 g from agents a where (%3$s) and (%4$s) is null  order by a.%1$I %2$s nulls last, a.id limit %5$s)
        ) u
    ) w
    where rn > %6$s and rn <= %7$s
  $q$, v_col, v_dir, v_where, v_match, v_take, p_offset, v_take)
  into v_ids;
  return coalesce(v_ids, '{}');
end;
$function$;
