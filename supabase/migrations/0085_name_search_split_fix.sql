-- 0085: correct 0083's split — it was slower than the thing it replaced for 2 of 3 term types.
--
-- 0083 replaced the top-bar ORDER BY with a three-way union (matched / not matched / undecidable),
-- each branch bounded by offset+limit. Measured in isolation it looked like a 12x win. Measured
-- through fn_filter_search it was not:
--
--     term type   0083 split     what it replaced
--     name          3,186 ms       6,671 ms   (better, but nowhere near what was claimed)
--     phone         4,233 ms       ~4,600 ms  (no real gain)
--     email         7,094 ms        4,642 ms  (WORSE)
--
-- Cause: a branch that returns NO rows is the expensive one. It has no index to satisfy its
-- predicate, so it walks the whole sales_volume index to discover it is empty. And exactly one
-- branch is empty in every case -- all three are provably empty against current data:
--
--     select count(*) filter (where full_name is null)              -> 0   (name: branch 3)
--     select count(*) filter (where preferred_phone_digits is null) -> 0   (phone: branch 3)
--     -- email branch 2 is "not (a or b or c)", which is only TRUE when all three are non-null:
--     select count(*) filter (where preferred_email is not null
--                               and enriched_email is not null
--                               and (source_ids->'agent_provided'->>'email') is not null) -> 0
--
-- EXPLAIN on email branch 2 shows it exactly: "Rows Removed by Filter: 1134299", actual rows=0.
--
-- Two fixes, applied per term type because the term types are not alike.
--
-- 1. THE SORT ONLY EVER NEEDED IDS. The 6,671 ms was never the ordering itself -- ordering ids
--    alone costs 1,268 ms (name) / 727 ms (phone) / 1,395 ms (email). The rest was Postgres
--    carrying 1.13M FULL-WIDTH rows through the sort, because the ORDER BY sat on the same query
--    that selects every column plus five correlated subqueries. Ordering a narrow (id, sort_key)
--    set and joining back recovers that for every term type, with no new index and no change to
--    which rows come back.
--
-- 2. THE SPLIT IS KEPT ONLY FOR NAME, where it genuinely wins: the match branch rides the
--    existing idx_agents_full_name_trgm (8.5 ms) and the non-match branch stops after 20 rows
--    (0.13 ms). Phone and email have no index on their match columns -- preferred_phone_digits
--    has none at all, and the email form is an OR across two columns plus a JSONB extraction --
--    so their match branch full-scans (1,987 ms / 3,678 ms) and the split is strictly worse than
--    simply ordering ids. They take the narrow-ordering path instead.
--
-- The empty name branch is made free by a guard predicate plus a zero-row partial index
-- (idx_agents_full_name_null, created separately with CONCURRENTLY). "full_name is null" is
-- exactly the condition under which "full_name ilike '...'" evaluates to NULL, so adding it as
-- an extra AND is a no-op on the result and gives the planner something indexable. If an agent
-- with a NULL full_name ever does appear, the index picks it up and the branch keeps working --
-- it degrades in speed, never in correctness.
--
-- Ordering is unchanged from 0083, which was verified id-for-id against the original at offsets
-- 0/20/100. The a.id tiebreaker stays (see 0083: the original was not deterministic against
-- itself, so LIMIT/OFFSET paging could repeat or skip rows).

-- Which of the three term forms is in play. Single source of truth so the split, the match
-- expression and the guard cannot drift apart.
CREATE OR REPLACE FUNCTION public.fn_agent_term_kind(p_filters jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when coalesce(p_filters->>'nameQuery', '') = '' then null
    when position('@' in p_filters->>'nameQuery') > 0 then 'email'
    when length(regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g')) >= 7 then 'phone'
    else 'name'
  end;
$function$;

-- Unchanged behaviour from 0083; now derives its branch from fn_agent_term_kind.
CREATE OR REPLACE FUNCTION public.fn_agent_match_expr(p_filters jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case fn_agent_term_kind(p_filters)
    when 'email' then
      format('(preferred_email ilike %1$L or enriched_email ilike %1$L or (source_ids->''agent_provided''->>''email'') ilike %1$L)',
             '%' || (p_filters->>'nameQuery') || '%')
    when 'phone' then
      format('(preferred_phone_digits like %L)',
             '%' || regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g') || '%')
    when 'name' then
      format('(full_name ilike %L)', '%' || (p_filters->>'nameQuery') || '%')
    else null
  end;
$function$;

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
  v_kind  text := fn_agent_term_kind(p_filters);
  v_match text := fn_agent_match_expr(p_filters);
  v_col   text := fn_agent_sort_col(p_sort_by);
  v_dir   text := case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end;
  v_take  int  := p_limit + p_offset;   -- each branch of the split only ever needs this many
  v_ids   uuid[];
begin
  if v_kind is null then
    -- no search term: ordinary ordered page, with the tiebreaker for stable paging
    execute format('select array_agg(id order by ord) from (select id, row_number() over () ord from (select a.id from agents a where %s order by a.%I %s nulls last, a.id limit %s offset %s) z) w',
                   v_where, v_col, v_dir, p_limit, p_offset)
      into v_ids;

  elsif v_kind = 'name' then
    -- three bounded branches, concatenated in branch order == the original relevance ordering.
    -- Branch 3 carries the indexable "full_name is null" guard; see the header.
    execute format($q$
      select array_agg(id order by rn) from (
        select id, row_number() over (order by g, sk %2$s nulls last, id) rn
          from (
            (select a.id, a.%1$I sk, 0 g from agents a where (%3$s) and (%4$s)     order by a.%1$I %2$s nulls last, a.id limit %5$s)
            union all
            (select a.id, a.%1$I sk, 1 g from agents a where (%3$s) and not (%4$s) order by a.%1$I %2$s nulls last, a.id limit %5$s)
            union all
            (select a.id, a.%1$I sk, 2 g from agents a where (%3$s) and a.full_name is null and (%4$s) is null
                                                             order by a.%1$I %2$s nulls last, a.id limit %5$s)
          ) u
      ) w
      where rn > %6$s and rn <= %7$s
    $q$, v_col, v_dir, v_where, v_match, v_take, p_offset, v_take)
    into v_ids;

  else
    -- email / phone: no index backs the match columns, so the split's match branch full-scans.
    -- Keep the original relevance ordering, but over ids only -- the width of the sorted row was
    -- the actual cost, not the ordering.
    execute format('select array_agg(id order by ord) from (select id, row_number() over () ord from (select a.id from agents a where %s order by (%s) desc nulls last, a.%I %s nulls last, a.id limit %s offset %s) z) w',
                   v_where, v_match, v_col, v_dir, p_limit, p_offset)
      into v_ids;
  end if;

  return coalesce(v_ids, '{}');
end;
$function$;
