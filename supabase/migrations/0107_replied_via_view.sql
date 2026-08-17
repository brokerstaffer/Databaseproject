-- 0107: "has this agent replied" now answered by v_replied_agents, covering both providers.
--
-- Four functions asked the question themselves, each hardcoding bison_client_leads. They now all
-- go through the view created in 0106, so Instantly replies feed the existing Replied column,
-- Replied filter and Replied sort with no UI change at all -- and a third provider later means
-- changing one view, not four functions.
--
-- What changed, exactly:
--   fn_agent_where      2 sites -- the Replied has/missing contact filter
--   fn_agent_order      1 site  -- the has_replied sort expression
--   fn_filter_search    4 sites -- has_replied in each row-shaping block (one is the retired
--                                 `if false` branch, updated too so the two cannot drift)
--   fn_agent_page_ids   the narrow-sort path: k still supplies bounced / campaign count / client
--                       names, but has_replied now comes from a join on the view
--
-- Deliberately NOT changed: has_bounced, campaign_count and client_campaigns still read
-- bison_client_leads alone. The agreed scope is replies only -- Instantly campaign membership is
-- not mirrored, so claiming Instantly numbers in those columns would be a lie.
--
-- fn_office_where needs no change: office mode has no Replied filter.
--
-- These are cumulative CREATE OR REPLACE definitions, so each function is re-emitted whole. The
-- bodies below are the live definitions with only the lines above altered.

CREATE OR REPLACE FUNCTION public.fn_agent_where(p_source text, p_filters jsonb, p_alias text DEFAULT 'a'::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  parts text[] := '{}';
  f jsonb; sub jsonb; arr text[]; kinds text[]; kind text; col text; field text;
  kconds text[]; vconds text[]; side text; c text; v text; vst text; vbase text;
  citycol text; statecol text; ccol text;
  v_client_ids text[];
  -- Alias of the agents relation this predicate gets pasted into. Most callers scan
  -- "from agents a"; the saved-view blocks nest a second agents scan aliased a9. Emissions that
  -- have to name the outer row (the saved-view references below, and the location exclude) use
  -- this instead of assuming 'a'. quote_ident keeps it out of injection range.
  v_alias text := quote_ident(coalesce(nullif(p_alias, ''), 'a'));
  view_id text; vv jsonb; vmode text; vsrc text; vwhere text;
  sel_mls uuid[]; scoped boolean := false; hconds text[] := '{}'; hc text;
  grp record;
begin
  -- A5 phase 3: MLS-scoped production filtering. Active only when EVERY selected MLS has
  -- near-complete per-MLS stats coverage (>= 90% of members) — until the 15-day refresh
  -- fills agent_mls_stats, behavior stays exactly as before.
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) > 0 then
    sel_mls := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
    select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
      into scoped from mls where id = any(sel_mls);
    scoped := coalesce(scoped, false);
  end if;
  if p_source = 'zillow_realtor' then
    parts := parts || format('sources && %L::text[]', array['zillow', 'realtor']);
  elsif p_source = 'courted' then
    parts := parts || format('sources && %L::text[]', array['courted']);
  end if;

  v_client_ids := case
    when jsonb_typeof(p_filters->'orchClientIds') = 'array' and jsonb_array_length(p_filters->'orchClientIds') > 0
      then array(select jsonb_array_elements_text(p_filters->'orchClientIds'))
    when coalesce(p_filters->>'orchClientId', '') <> ''
      then array[p_filters->>'orchClientId']
    else null end;
  if v_client_ids is not null then
    if coalesce(p_filters->>'orchClientMode', 'include') = 'exclude' then
      parts := parts || format('id not in (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id))', v_client_ids);
    else
      parts := parts || format('id in (select b.agent_id from bison_client_leads b where b.client_id = any(%1$L::uuid[]) and b.agent_id is not null union all select l.agent_id from orch_client_leads l where l.client_id = any(%1$L::uuid[]) and l.agent_id is not null and not exists (select 1 from bison_client_leads x where x.client_id = l.client_id))', v_client_ids);
    end if;
  end if;

  -- LOCATION (A14: values = include, excludeValues = exclude). Exclude wraps in
  -- not coalesce(cond, false) so agents with NULL location columns are KEPT — "not in Miami"
  -- must not drop agents whose location is simply unknown.
  f := p_filters->'location';
  if f is not null then
    field := coalesce(f->>'field', 'city');
    kinds := array(select jsonb_array_elements_text(coalesce(f->'appliesTo', '["office","home","transacted"]'::jsonb)));
    foreach side in array array['values', 'excludeValues'] loop
        field := case when side = 'excludeValues' then coalesce(nullif(f->>'excludeField', ''), f->>'field') else f->>'field' end; -- D3: exclude may target a different geography level
      if jsonb_typeof(f->side) = 'array' and jsonb_array_length(f->side) > 0 then
        kconds := '{}';
        -- values may MIX geography levels: plain strings use the side's field; objects
        -- {"f": "county", "v": "Bucks, PA"} carry their own. Each level's group builds its
        -- own condition; the side OR's them together (include) / excludes them all.
        for grp in
          select coalesce(case when jsonb_typeof(e.value) = 'object' then nullif(e.value->>'f', '') end, field) as ef,
                 jsonb_agg(case when jsonb_typeof(e.value) = 'object' then e.value->>'v' else e.value #>> '{}' end) as vals
            from jsonb_array_elements(f->side) e
           group by 1
        loop
        foreach kind in array kinds loop
          citycol := case kind when 'office' then 'office_city' when 'home' then 'home_city' when 'transacted' then 'most_transacted_city' else null end;
          statecol := case kind when 'office' then 'office_state' when 'home' then 'home_state' when 'transacted' then 'transacted_state' else null end;
          ccol := case kind when 'office' then 'office_county' when 'home' then 'home_county' when 'transacted' then 'most_transacted_county' else null end;
          if citycol is null then continue; end if;

          if grp.ef = 'city' or grp.ef = 'county' then
            -- keys are computed HERE (once) and matched via = ANY(array): one match-key
            -- evaluation per row per kind, index-friendly. The old per-value OR chain
            -- evaluated the regex key per VALUE per row — a 40-city saved view was ~93M
            -- regex calls and blew the API statement timeout (rendered as "0 agents").
            vconds := '{}';
            arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end
                         from jsonb_array_elements_text(grp.vals) x(v)
                         where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is null
                           and (case when grp.ef = 'city' then fn_city_match_key(x.v) else lower(trim(x.v)) end) is not null);
            if array_length(arr, 1) > 0 then
              if grp.ef = 'city' then
                vconds := vconds || format('%I = ANY(%L::text[])', citycol || '_key', arr);
              else
                vconds := vconds || format('lower(%I) = ANY(%L::text[])', ccol, arr);
              end if;
            end if;
            for vst in select distinct upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1])
                       from jsonb_array_elements_text(grp.vals) x(v)
                       where (regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$')) is not null loop
              arr := array(select distinct case when grp.ef = 'city' then fn_city_match_key(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) else lower(trim(regexp_replace(x.v, ',\s*[A-Za-z]{2}\s*$', ''))) end
                           from jsonb_array_elements_text(grp.vals) x(v)
                           where upper((regexp_match(x.v, ',\s*([A-Za-z]{2})\s*$'))[1]) = vst);
              arr := array(select y from unnest(arr) y where y is not null);
              if array_length(arr, 1) > 0 then
                if grp.ef = 'city' then
                  vconds := vconds || format('(%I = ANY(%L::text[]) and coalesce(upper(%I), fn_city_embedded_state(%I)) = %L)', citycol || '_key', arr, statecol, citycol, vst);
                else
                  vconds := vconds || format('(lower(%I) = ANY(%L::text[]) and upper(%I) = %L)', ccol, arr, statecol, vst);
                end if;
              end if;
            end loop;
            if array_length(vconds, 1) > 0 then kconds := kconds || ('(' || array_to_string(vconds, ' or ') || ')'); end if;
          else
            arr := array(select jsonb_array_elements_text(grp.vals));
            col := case grp.ef
              when 'zip' then case kind when 'office' then 'office_zip' when 'home' then 'home_zip' else 'most_transacted_zip' end
              when 'state' then statecol
              else null end;
            if grp.ef = 'state' and col is not null then
              kconds := kconds || format('upper(%I) = ANY(%L::text[])', col, (select array_agg(upper(u)) from unnest(arr) u));
            elsif col is not null then
              kconds := kconds || format('%I = ANY(%L::text[])', col, arr);
            end if;
          end if;
        end loop;
        end loop;
        if array_length(kconds, 1) > 0 then
          if side = 'excludeValues' then
            -- Excluding places emitted "not coalesce((<or of column tests>), false)". Nothing
            -- about that is indexable, so Postgres read all 1.13M agents and deformed each wide
            -- row to reach up to nine location columns. Excluding 7 cities measured 6,379 ms in
            -- the count alone, against 260 ms to INCLUDE the same 7; the 20-row page was 0.46 ms,
            -- so effectively the whole cost was the count.
            --
            -- Asked the other way round -- find the agents that DO match, via the indexes that
            -- already exist, and keep everyone else -- it plans as a hash anti-join.
            --
            -- NOT EXISTS specifically, not NOT IN. An earlier attempt used "id not in (select
            -- ...)", which is alias-free and looks equivalent. It is not: NOT IN cannot always
            -- become an anti-join because of its NULL rules, and when the planner's estimate
            -- exceeds work_mem it silently falls back to a per-row subplan. City excludes went
            -- 6,132 -> 1,061 ms, but excluding two states went 1,797 ms -> over ten minutes.
            -- NOT EXISTS is a true anti-join and has no such cliff.
            --
            -- The price is that NOT EXISTS must name the outer row, hence v_alias. Get that
            -- wrong and the subquery compares a row to itself and matches everything, so the
            -- alias is threaded explicitly through every nested call rather than assumed.
            parts := parts || format('not exists (select 1 from agents axl where axl.id = %s.id and (%s))',
                                     v_alias, array_to_string(kconds, ' or '));
          else
            parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
          end if;
        end if;
      end if;
    end loop;
  end if;

  f := p_filters->'salesVolume';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_dollar)' when 'buy' then 'sum(buy_side_dollar)' else 'sum(sales_volume)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_dollar' when 'buy' then 'buy_side_dollar' else 'sales_volume' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'closedUnits';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_count)' when 'buy' then 'sum(buy_side_count)' else 'sum(units)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'units' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'closedTransactions';
  if f is not null then
    side := coalesce(f->>'side', 'all');
    if scoped then
      hc := fn_range_cond_expr(case side when 'list' then 'sum(list_side_count)' when 'buy' then 'sum(buy_side_count)' else 'sum(closed_transactions)' end, f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      col := case side when 'list' then 'list_side_count' when 'buy' then 'buy_side_count' else 'closed_transactions' end;
      c := fn_range_cond(col, f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'estTimeInIndustry';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_in_industry_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'approxGci';
  if f is not null then
    if scoped then
      hc := fn_range_cond_expr('sum(approx_gci)', f); if hc is not null then hconds := hconds || hc; end if;
    else
      c := fn_range_cond('approx_gci', f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'avgSalePrice';
  if f is not null then
    if scoped then
      hc := fn_range_cond_expr('(sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / nullif(sum(units), 0))', f);
      if hc is not null then hconds := hconds || hc; end if;
    else
      c := fn_range_cond('avg_sale_price', f); if c is not null then parts := parts || c; end if;
    end if;
  end if;

  f := p_filters->'estTimeInOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('est_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'avgTimeAtOffice';
  if f is not null then
    f := f || jsonb_build_object('min', (nullif(f->>'min', '')::numeric) * 12, 'max', (nullif(f->>'max', '')::numeric) * 12);
    c := fn_range_cond('avg_time_at_office_months', f); if c is not null then parts := parts || c; end if;
  end if;

  f := p_filters->'officeSearch';
  if f is not null then
    sub := f->'brand';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('brand = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(brand is null or brand <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
    sub := f->'office';
    if sub is not null then
      if jsonb_array_length(coalesce(sub->'include', '[]'::jsonb)) > 0 then
        parts := parts || format('office_name = ANY(%L::text[])', array(select jsonb_array_elements_text(sub->'include')));
      end if;
      if jsonb_array_length(coalesce(sub->'exclude', '[]'::jsonb)) > 0 then
        parts := parts || format('(office_name is null or office_name <> ALL(%L::text[]))', array(select jsonb_array_elements_text(sub->'exclude')));
      end if;
    end if;
  end if;

  f := p_filters->'mls';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('id in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('id not in (select agent_id from agent_mls where mls_id = ANY(%L::uuid[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;


  -- A5: agents affiliated with 2+ MLSs
  if coalesce(p_filters->>'multiMls', '') = 'true' then
    parts := parts || 'mls_count >= 2'::text;
  end if;

  -- Agents present in more than one campaign. Unlike multiMls there is no maintained counter
  -- column to lean on (mls_count is one), so this groups bison_client_leads -- 110k rows behind
  -- idx_bcl_agent, measured 203 ms. A lead can sit in several campaigns of the SAME client, and
  -- that still counts: the question is how many campaigns the agent is in, not how many clients.
  if coalesce(p_filters->>'multiCampaign', '') = 'true' then
    parts := parts || 'id in (select agent_id from bison_client_leads where agent_id is not null group by agent_id having count(distinct campaign_id) >= 2)'::text;
  end if;

  -- B3: exact MLS-affiliation-count buckets ('2','3','4','5' exact, '6+' open-ended),
  -- OR'd together, over the trigger-maintained agents.mls_count column.
  f := p_filters->'mlsCount';
  if f is not null and jsonb_array_length(coalesce(f->'buckets', '[]'::jsonb)) > 0 then
    kconds := '{}';
    for kind in select jsonb_array_elements_text(f->'buckets') loop
      if kind = '6+' then
        kconds := kconds || 'mls_count >= 6'::text;
      elsif kind ~ '^[0-9]+$' then
        kconds := kconds || format('mls_count = %s', kind::int);
      end if;
    end loop;
    if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
  end if;

  -- A12: saved views as LIVE include/exclude sets. Each referenced view resolves to its
  -- current membership (its own stored filters, source and mode) via correlated EXISTS
  -- anti-joins (NOT IN over 770k ids planned as an O(n^2) null-aware subplan and timed out).
  -- Requires the outer agents relation to be aliased "a" (fn_filter_search / fn_filter_ids).
  -- INCLUDE = agent in ANY selected view (union — multiple lead lists compose additively);
  -- EXCLUDE = agent in NONE of the selected views. A referenced view's own nested saved-view
  -- refs are stripped (depth 1 -> cycles impossible); broken/deleted views are skipped.
  f := p_filters->'savedViews';
  if f is not null then
    for side in select unnest(array['include', 'exclude']) loop
      kconds := '{}';
      if jsonb_typeof(f->side) = 'array' then
        for view_id in select jsonb_array_elements_text(f->side) loop
          begin
            select filters, coalesce(mode, 'agent'), coalesce(source_mode, 'courted')
              into vv, vmode, vsrc from saved_lists where id = view_id::uuid;
            if vv is not null then
              vv := vv - 'savedViews';
              if vmode = 'office' then
                kconds := kconds || format('%s.office_id in (select o9.id from offices o9 where (%s))', v_alias, fn_office_where(vv));
              elsif side = 'include' then
                -- INCLUDE inlines: the view's conditions reference bare agents columns, so they
                -- apply straight to the outer relation -- one indexed scan instead of a subquery
                -- returning up to 1.1M ids. Measured 4.7 s -> 1.1 s for two views.
                kconds := kconds || format('(%s)', fn_agent_where(vsrc, vv, p_alias));
              else
                -- EXCLUDE keeps the subquery. Negation cannot use an index, so an inlined
                -- "not (...)" degrades to a full scan evaluating every condition per row:
                -- 6.6 s inlined vs 1.5 s as a hashed anti-join, same 1,100,594 rows. The
                -- subquery form also carries the right NULL semantics for free -- an agent the
                -- view does not return is simply not IN it, so excluding the view keeps them.
                kconds := kconds || format('%s.id in (select a9.id from agents a9 where (%s))', v_alias, fn_agent_where(vsrc, vv, 'a9'));
              end if;
            end if;
          exception when others then
            null; -- deleted id / malformed stored filters: skip this view, keep the search alive
          end;
        end loop;
      end if;
      if array_length(kconds, 1) > 0 then
        if side = 'exclude' then
          parts := parts || ('not (' || array_to_string(kconds, ' or ') || ')');
        else
          parts := parts || ('(' || array_to_string(kconds, ' or ') || ')');
        end if;
      end if;
    end loop;
  end if;

  f := p_filters->'title';
  if f is not null then
    -- title may hold multiple titles separated by comma or slash (e.g. 'Salesperson, Team Leader').
    -- Match per token, ignoring case/spacing/punctuation ('sales person' == 'Salesperson').
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format(
        'fn_title_tokens(title) && %L::text[]',
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'include') x(v)));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      -- Same shape as the location exclude: "not (tokens && array)" is a NOT over a GIN index,
      -- which no index can serve, so it scanned all 1.13M agents and called fn_title_tokens on
      -- every row -- 3,238 ms for the count, the worst single filter in a 325-combination sweep,
      -- and it poisoned every pair it appeared in (up to 10,934 ms). Asked as an anti-join over
      -- the POSITIVE form it rides idx_agents_title_tokens instead.
      --
      -- Semantics unchanged: the old form kept a row when the title was NULL or no token
      -- overlapped; NOT EXISTS keeps a row when the positive is not true -- the same two cases,
      -- since a NULL title cannot overlap. v_alias is threaded for the same reason as the
      -- location exclude: the saved-view blocks nest a second agents scan aliased a9.
      parts := parts || format(
        'not exists (select 1 from agents axt where axt.id = %s.id and fn_title_tokens(axt.title) && %L::text[])',
        v_alias,
        array(select distinct regexp_replace(lower(x.v), '[^a-z0-9]', '', 'g') from jsonb_array_elements_text(f->'exclude') x(v)));
    end if;
  end if;

  f := p_filters->'license';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      parts := parts || format('license_number = ANY(%L::text[])', array(select jsonb_array_elements_text(f->'include')));
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      parts := parts || format('(license_number is null or license_number <> ALL(%L::text[]))', array(select jsonb_array_elements_text(f->'exclude')));
    end if;
  end if;

  f := p_filters->'name';
  if f is not null then
    if jsonb_array_length(coalesce(f->'include', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'include') loop
        kconds := kconds || format('full_name ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(' || array_to_string(kconds, ' or ') || ')'); end if;
    end if;
    if jsonb_array_length(coalesce(f->'exclude', '[]'::jsonb)) > 0 then
      kconds := '{}';
      for kind in select jsonb_array_elements_text(f->'exclude') loop
        kconds := kconds || format('full_name not ilike %L', '%' || kind || '%');
      end loop;
      if array_length(kconds, 1) > 0 then parts := parts || ('(full_name is null or (' || array_to_string(kconds, ' and ') || '))'); end if;
    end if;
  end if;

  f := p_filters->'zillowRealtor';
  if f is not null then
    if jsonb_array_length(coalesce(f->'languages', '[]'::jsonb)) > 0 then
      -- The unnest + lower() form could not use idx_agents_languages, so this scanned the whole
      -- table: 3,001 ms, against 0.98 ms for the indexable "languages && '{Spanish}'". Matching
      -- stays case-insensitive -- fn_lower_arr lowercases the stored array and has its own GIN
      -- index -- so a value stored as "spanish" still matches a search for "Spanish".
      parts := parts || format('fn_lower_arr(languages) && %L::text[]',
        array(select lower(jsonb_array_elements_text(f->'languages'))));
    end if;
    c := fn_range_cond('total_sales_all_time', f->'totalSales'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_price_all_time', f->'avgPriceAllTime'); if c is not null then parts := parts || c; end if;
    c := fn_range_cond('avg_sales_volume_all_time', f->'avgVolumeAllTime'); if c is not null then parts := parts || c; end if;
    if (f->>'hasLinkedin') = 'true' then parts := parts || 'linkedin_url is not null'::text; end if;
  end if;

  -- A3: contact has/missing (email presence counts preferred OR enriched)
  f := p_filters->'contact';
  if f is not null then
    if f->>'email' = 'has' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is not null'::text;
    elsif f->>'email' = 'missing' then
      parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text;
    end if;
    if f->>'phone' = 'has' then
      parts := parts || '(preferred_phone is not null and preferred_phone <> '''')'::text;
    elsif f->>'phone' = 'missing' then
      parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text;
    end if;
    -- C2: been through enrichment and holds a verified email
    if f->>'enriched' = 'has' then
      parts := parts || '(enriched_at is not null and enriched_email is not null)'::text;
    elsif f->>'enriched' = 'missing' then
      parts := parts || '(enriched_at is null or enriched_email is null)'::text;
    end if;
    -- C4: has this lead EVER replied to us, in EITHER provider. The view unions the Bison flag
    -- with the Instantly reply mirror, so a third provider later changes only that one object.
    -- It filters agent_id is not null, which the 'missing' branch depends on: a single NULL
    -- inside a NOT IN makes the whole predicate return zero rows.
    if f->>'replied' = 'has' then
      parts := parts || 'id in (select agent_id from v_replied_agents)'::text;
    elsif f->>'replied' = 'missing' then
      parts := parts || 'id not in (select agent_id from v_replied_agents)'::text;
    end if;
    -- C1: the lead's emails BOUNCED (flag maintained by the 6-hourly Bison sync)
    if f->>'bounced' = 'has' then
      parts := parts || 'id in (select agent_id from bison_client_leads where bounced and agent_id is not null)'::text;
    elsif f->>'bounced' = 'missing' then
      parts := parts || 'id not in (select agent_id from bison_client_leads where bounced and agent_id is not null)'::text;
    end if;
    -- C5: already sitting in a client's Bison campaign
    if f->>'inCampaign' = 'has' then
      parts := parts || 'id in (select agent_id from bison_client_leads where agent_id is not null)'::text;
    elsif f->>'inCampaign' = 'missing' then
      parts := parts || 'id not in (select agent_id from bison_client_leads where agent_id is not null)'::text;
    end if;
  end if;

  -- legacy missingContact (old saved views)
  f := p_filters->'missingContact';
  if f is not null then
    if (f->>'email') = 'true' then parts := parts || 'coalesce(nullif(preferred_email, ''''), nullif(enriched_email, '''')) is null'::text; end if;
    if (f->>'phone') = 'true' then parts := parts || '(preferred_phone is null or preferred_phone = '''')'::text; end if;
  end if;

  if scoped and array_length(hconds, 1) > 0 then
    parts := parts || format('id in (select agent_id from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id having %s)',
                             sel_mls, array_to_string(hconds, ' and '));
  end if;

  if array_length(parts, 1) > 0 then return array_to_string(parts, ' and '); end if;
  return 'true';
end;
$function$

;

CREATE OR REPLACE FUNCTION public.fn_agent_order(p_filters jsonb, p_sort_by text, p_sort_dir text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when coalesce(p_filters->>'nameQuery', '') = '' then ''
    when position('@' in p_filters->>'nameQuery') > 0
      then format('(preferred_email ilike %1$L or enriched_email ilike %1$L or (source_ids->''agent_provided''->>''email'') ilike %1$L) desc nulls last, ',
                  '%' || (p_filters->>'nameQuery') || '%')
    when length(regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g')) >= 7
      then format('(preferred_phone_digits like %L) desc nulls last, ',
                  '%' || regexp_replace(p_filters->>'nameQuery', '[^0-9]', '', 'g') || '%')
    else format('(full_name ilike %L) desc nulls last, ', '%' || (p_filters->>'nameQuery') || '%') end
  || case when p_sort_by = 'has_bounced' then
       -- mirrors has_replied below: a hashed IN over the small bounced set, never a per-row
       -- subquery in the sort
       format('(a.id in (select agent_id from bison_client_leads where bounced and agent_id is not null)) %s, sales_volume desc nulls last',
              case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end)
     when p_sort_by = 'has_replied' then
       -- computed flag: hashed IN over the (small) replied set — never a per-row subquery sort
       format('(a.id in (select agent_id from v_replied_agents)) %s, sales_volume desc nulls last',
              case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end)
     else format('%I %s nulls last',
       case p_sort_by
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
         else 'sales_volume' end,
       case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end) end;
$function$

;

CREATE OR REPLACE FUNCTION public.fn_agent_page_ids(p_source text, p_filters jsonb, p_sort_by text, p_sort_dir text, p_limit integer, p_offset integer)
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
  v_join  text := '';
  v_sk    text;
  v_ids   uuid[];
begin
  -- Computed sorts (Replied / Bounced / Client campaign / Campaigns) are not columns, so they
  -- used to be excluded from this narrow path and fell back to sorting 1.13M FULL-WIDTH rows:
  -- 2,848 ms for Replied and 2,776 ms for Client campaign, against 117 ms for an ordinary
  -- column. All four are answered by ONE aggregate over bison_client_leads (110k rows behind
  -- idx_bcl_agent), joined once and sorted as a narrow (id, key) set like everything else.
  if p_sort_by in ('has_replied', 'has_bounced', 'client_campaigns', 'campaign_count') then
    v_join := ' left join (select b.agent_id,'
           || ' bool_or(b.replied) hr, bool_or(b.bounced) hb,'
           || ' count(distinct b.campaign_id) cn,'
           || ' string_agg(distinct c.client_name, '', '' order by c.client_name) cc'
           || ' from bison_client_leads b join orch_clients c on c.id = b.client_id'
           || ' where b.agent_id is not null group by b.agent_id) k on k.agent_id = a.id'
           -- Replied comes from the shared view, not k.hr, so the sort covers BOTH
           -- providers. k still supplies bounced / campaign count / client names.
           || ' left join v_replied_agents vr on vr.agent_id = a.id';
    -- coalesce so agents in no campaign sort as false/0 rather than NULL, matching what the
    -- table renders for them (an em dash, i.e. "not replied" / "not bounced" / none)
    v_sk := case p_sort_by
              when 'has_replied'    then '(vr.agent_id is not null)'
              when 'has_bounced'    then 'coalesce(k.hb, false)'
              when 'campaign_count' then 'coalesce(k.cn, 0)'
              else 'k.cc' end;
  else
    v_sk := format('a.%I', v_col);
  end if;

  if v_kind is null then
    execute format('select array_agg(id order by ord) from (select id, row_number() over () ord from (select a.id from agents a%s where %s order by %s %s nulls last, a.id limit %s offset %s) z) w',
                   v_join, v_where, v_sk, v_dir, p_limit, p_offset)
      into v_ids;

  elsif v_kind = 'name' then
    execute format($q$
      select array_agg(id order by rn) from (
        select id, row_number() over (order by g, sk %2$s nulls last, id) rn
          from (
            (select a.id, %1$s sk, 0 g from agents a%8$s where (%3$s) and (%4$s)     order by %1$s %2$s nulls last, a.id limit %5$s)
            union all
            (select a.id, %1$s sk, 1 g from agents a%8$s where (%3$s) and not (%4$s) order by %1$s %2$s nulls last, a.id limit %5$s)
            union all
            (select a.id, %1$s sk, 2 g from agents a%8$s where (%3$s) and a.full_name is null and (%4$s) is null
                                                             order by %1$s %2$s nulls last, a.id limit %5$s)
          ) u
      ) w
      where rn > %6$s and rn <= %7$s
    $q$, v_sk, v_dir, v_where, v_match, v_take, p_offset, v_take, v_join)
    into v_ids;

  else
    execute format('select array_agg(id order by ord) from (select id, row_number() over () ord from (select a.id from agents a%s where %s order by (%s) desc nulls last, %s %s nulls last, a.id limit %s offset %s) z) w',
                   v_join, v_where, v_match, v_sk, v_dir, p_limit, p_offset)
      into v_ids;
  end if;

  return coalesce(v_ids, '{}');
end;
$function$

;

CREATE OR REPLACE FUNCTION public.fn_filter_search(p_mode text DEFAULT 'agent'::text, p_source text DEFAULT 'courted'::text, p_filters jsonb DEFAULT '{}'::jsonb, p_sort_by text DEFAULT 'sales_volume'::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '128MB'
AS $function$
declare v_where text; v_order text; v_sort_col text; v_dir text; v_count bigint; v_volume numeric; v_data jsonb; v_minoff int;
  v_gran text; v_lbl text; v_grp text; v_nn text; v_kind text; v_ccol text; v_kcol text; v_stcol text; v_ctycol text; v_kinds text[]; v_vals text;
  sel_mls uuid[]; scoped boolean := false; v_sc text; v_scord text; v_page uuid[]; v_having text;
  v_cache jsonb;
begin
  if p_mode = 'mls' then
    -- B8: MLS grain — the filtered agents grouped by MLS membership. A multi-MLS agent
    -- counts under each of their MLSs (same convention as the Location tab's places).
    v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
    v_sort_col := case p_sort_by when 'mls' then 'label' when 'agents' then 'agents' when 'offices' then 'offices' when 'units' then 'units' when 'updated' then 'updated' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    -- 0096: unfiltered => serve the precomputed grouped set (4,441 ms -> ~10 ms). The
    -- eligibility test compares the generated WHERE against the no-filter WHERE for this
    -- source, so a filtered request can never read it; a miss returns null and falls straight
    -- through to the live query below.
    if v_where = fn_agent_where(p_source, '{}'::jsonb) then
      v_cache := fn_perf_view_read('mls:' || p_source, v_sort_col, v_dir, p_limit, p_offset);
      if v_cache is not null then return v_cache; end if;
    end if;
    execute format($q$
      with sel as (select a.id, a.office_id, a.sales_volume, a.units from agents a where %s),
      g as (
        select m.id as mls_id, coalesce(m.name, m.code) as label, m.code,
               to_char(m.bulk_refreshed_at, 'YYYY-MM-DD') as updated,
               count(*)::bigint as agents, count(distinct sel.office_id)::bigint as offices,
               coalesce(sum(sel.sales_volume), 0)::numeric as sales_volume, coalesce(sum(sel.units), 0)::numeric as units
          from sel
          join agent_mls am on am.agent_id = sel.id
          join mls m on m.id = am.mls_id
         group by m.id, m.name, m.code, m.bulk_refreshed_at
      )
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, label asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_sort_col, v_dir, p_limit, p_offset)
    into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'location' then
    -- D4 + Stephanie's follow-up: location grain over a chosen BASIS — the agent's office,
    -- home, or most-transacted location, or ALL three combined (an agent counts once per
    -- place even when several of their locations land in the same place).
    v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
    v_gran := case p_filters->>'locGranularity' when 'county' then 'county' when 'city' then 'city' else 'state' end;
    -- multi-select basis: locKinds = any subset of office/home/transacted (legacy locKind honored)
    v_kinds := array(select x from jsonb_array_elements_text(coalesce(p_filters->'locKinds', '[]'::jsonb)) x
                      where x in ('office', 'home', 'transacted'));
    if array_length(v_kinds, 1) is null then
      v_kinds := case p_filters->>'locKind'
        when 'home' then array['home'] when 'transacted' then array['transacted']
        when 'all' then array['office', 'home', 'transacted'] else array['office'] end;
    end if;
    v_kind := case when array_length(v_kinds, 1) = 1 then v_kinds[1] else 'all' end;
    v_sort_col := case p_sort_by when 'location' then 'location' when 'agents' then 'agents' when 'offices' then 'offices' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;

    -- 0096: unfiltered => serve the precomputed grouped set. Biggest win in the app: the
    -- all-three-basis views cost 18-23 s live, because every agent expands to three rows
    -- before dedup. Keyed by source + granularity + basis; anything not populated falls
    -- through to the live query unchanged.
    if v_where = fn_agent_where(p_source, '{}'::jsonb) then
      v_cache := fn_perf_view_read('location:' || p_source || ':' || v_gran || ':' || v_kind,
                                   v_sort_col, v_dir, p_limit, p_offset);
      if v_cache is not null then return v_cache; end if;
    end if;

    if v_kind <> 'all' then
      if v_kind = 'office' then v_ccol := 'office_city'; v_kcol := 'office_city_key'; v_stcol := 'office_state'; v_ctycol := 'office_county';
      elsif v_kind = 'home' then v_ccol := 'home_city'; v_kcol := 'home_city_key'; v_stcol := 'home_state'; v_ctycol := 'home_county';
      else v_ccol := 'most_transacted_city'; v_kcol := 'most_transacted_city_key'; v_stcol := 'transacted_state'; v_ctycol := 'most_transacted_county';
      end if;
      if v_gran = 'state' then
        v_lbl := format('upper(a.%I)', v_stcol); v_grp := format('upper(a.%I)', v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L', v_stcol, v_stcol, '');
      elsif v_gran = 'county' then
        v_lbl := format('initcap(min(a.%I)) || %L || upper(a.%I)', v_ctycol, ', ', v_stcol);
        v_grp := format('lower(a.%I), upper(a.%I)', v_ctycol, v_stcol);
        v_nn := format('a.%I is not null and btrim(a.%I) <> %L and a.%I is not null', v_ctycol, v_ctycol, '', v_stcol);
      else
        v_lbl := format('min(a.%I) || %L || upper(a.%I)', v_ccol, ', ', v_stcol);
        v_grp := format('a.%I, upper(a.%I)', v_kcol, v_stcol);
        v_nn := format('a.%I is not null and a.%I is not null', v_kcol, v_stcol);
      end if;
      execute format($q$
        with g as (
          select %s as location, count(*)::bigint as agents, count(distinct a.office_id)::bigint as offices,
                 coalesce(sum(a.sales_volume), 0)::numeric as sales_volume, coalesce(sum(a.units), 0)::numeric as units
            from agents a
           where (%s) and %s
           group by %s
        )
        select (select count(*) from g),
               (select coalesce(sum(sales_volume), 0) from g),
               coalesce((select jsonb_agg(to_jsonb(t)) from (
                  select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
      $q$, v_lbl, v_where, v_nn, v_grp, v_sort_col, v_dir, p_limit, p_offset)
      into v_count, v_volume, v_data;
      return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
    end if;

    -- Multi-kind basis: expand each agent to the SELECTED kinds' tuples, dedup to one row
    -- per (place, agent), then aggregate — a place's numbers never double-count an agent.
    v_vals := array_to_string(array(
      select case k
        when 'office' then '(a.office_city_key, a.office_city, upper(a.office_state), a.office_county)'
        when 'home' then '(a.home_city_key, a.home_city, upper(a.home_state), a.home_county)'
        else '(a.most_transacted_city_key, a.most_transacted_city, upper(a.transacted_state), a.most_transacted_county)'
      end from unnest(v_kinds) k), ', ');
    if v_gran = 'state' then
      v_grp := 'v.st'; v_lbl := 'p.gkey'; v_nn := 'v.st is not null'; v_ccol := 'min(v.rawc)';
    elsif v_gran = 'county' then
      v_grp := 'lower(v.cty)'; v_lbl := $c$initcap(n.disp) || ', ' || p.gst$c$;
      v_nn := $c$v.cty is not null and btrim(v.cty) <> '' and v.st is not null$c$;
      v_ccol := 'min(v.cty)'; -- display = the county's raw spelling
    else
      v_grp := 'v.ck'; v_lbl := $c$n.disp || ', ' || p.gst$c$;
      v_nn := 'v.ck is not null and v.st is not null';
      v_ccol := 'min(v.rawc)'; -- display = the city's raw spelling
    end if;
    execute format($q$
      with lat as (
        select a.id, a.office_id, a.sales_volume, a.units, v.ck, v.rawc, v.st, v.cty
          from agents a
          cross join lateral (values %s) v(ck, rawc, st, cty)
         where (%s) and %s
      ),
      pairs as (
        select distinct %s as gkey, v.st as gst, id, office_id, sales_volume, units from lat v
      ),
      names as (
        select %s as gkey, v.st as gst, %s as disp from lat v group by 1, 2
      ),
      g as (
        select %s as location, count(*)::bigint as agents, count(distinct p.office_id)::bigint as offices,
               coalesce(sum(p.sales_volume), 0)::numeric as sales_volume, coalesce(sum(p.units), 0)::numeric as units
          from pairs p left join names n on n.gkey = p.gkey and n.gst is not distinct from p.gst
         group by p.gkey, p.gst, n.disp
      )
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, location asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_vals, v_where, v_nn, v_grp, v_grp, v_ccol, v_lbl, v_sort_col, v_dir, p_limit, p_offset)
    into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'brand' then
    -- B5: brand grain = GROUP BY brand over the (filtered) offices table. Office-level
    -- filters apply per office BEFORE aggregation. Single-office "brands" are just the
    -- brokerage's own name (91k of 97k), so they are hidden unless the caller passes
    -- includeSingleOfficeBrands=true.
    -- "Agent Count" in the Brand view means agents in the BRAND, so it is applied to the
    -- brand total AFTER grouping. It used to be handed to fn_office_where, which put it in
    -- the WHERE that runs BEFORE "group by brand" -- so it actually asked "which OFFICES
    -- have N agents", then summed whichever offices survived. Two wrong answers came out of
    -- that: brands built from many small offices disappeared entirely (min=100 showed 93 of
    -- the 471 brands that really have 100+ agents -- NextHome, 2,588 agents across 415
    -- offices, was hidden because no single office reaches 100), and the Agent Count column
    -- showed a partial sum for the brands that did survive (Keller Williams read 64,302
    -- instead of 84,509). Office view keeps the per-office meaning, which is correct there.
    v_where  := fn_office_where(coalesce(p_filters, '{}'::jsonb) - 'agentCount');
    -- Office and Brand were missing this. A saved view carrying an MLS plus a range filter puts a
    -- grouped agent_mls_stats subquery into the office WHERE too (via the saved-view block that
    -- resolves the view at agent grain), and the planner mis-estimates it exactly as it does at
    -- agent grain. Measured on the BHS Base Camp view: office 2,140 ms with nested loops, 191 ms
    -- without.
    perform fn_nestloop_guard(v_where);
    v_having := coalesce(fn_range_cond('agent_count', p_filters->'agentCount'), 'true');
    v_sort_col := case p_sort_by when 'brand' then 'brand' when 'office_count' then 'office_count' when 'agent_count' then 'agent_count' when 'units' then 'units' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    v_minoff := case when coalesce(p_filters->>'includeSingleOfficeBrands', '') = 'true' then 1 else 2 end;
    execute format($q$
      with g0 as (
        select brand, count(*)::int as office_count, coalesce(sum(agent_count), 0)::bigint as agent_count,
               coalesce(sum(sales_volume), 0)::numeric as sales_volume, coalesce(sum(units), 0)::numeric as units
          from offices
         where (%s) and brand is not null and btrim(brand) <> ''
         group by brand
        having count(*) >= %s
      ), g as (select * from g0 where %s)
      select (select count(*) from g),
             (select coalesce(sum(sales_volume), 0) from g),
             coalesce((select jsonb_agg(to_jsonb(t)) from (
                select * from g order by %I %s nulls last, brand asc limit %s offset %s) t), '[]'::jsonb)
    $q$, v_where, v_minoff, v_having, v_sort_col, v_dir, p_limit, p_offset) into v_count, v_volume, v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  if p_mode = 'office' then
    v_where := fn_office_where(p_filters);
    -- Office and Brand were missing this. A saved view carrying an MLS plus a range filter puts a
    -- grouped agent_mls_stats subquery into the office WHERE too (via the saved-view block that
    -- resolves the view at agent grain), and the planner mis-estimates it exactly as it does at
    -- agent grain. Measured on the BHS Base Camp view: office 2,140 ms with nested loops, 191 ms
    -- without.
    perform fn_nestloop_guard(v_where);
    v_sort_col := case p_sort_by when 'office_name' then 'office_name' when 'units' then 'units' when 'agent_count' then 'agent_count' when 'list_side_dollar' then 'list_side_dollar' when 'buy_side_dollar' then 'buy_side_dollar' when 'brand' then 'brand' when 'office_city' then 'office_city' when 'office_zip' then 'office_zip' else 'sales_volume' end;
    v_dir := case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end;
    execute format('select count(*), coalesce(sum(sales_volume), 0) from offices where %s', v_where) into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t.j), '[]'::jsonb) from (
        select to_jsonb(o) || jsonb_build_object(
                 'agent_names', (select coalesce(jsonb_agg(ag.full_name order by ag.sv desc nulls last), '[]'::jsonb)
                                  from (select full_name, sales_volume sv from agents where office_id = o.id order by sales_volume desc nulls last limit 25) ag)
               ) as j
        from offices o where %s order by o.%I %s nulls last limit %s offset %s
      ) t $q$, v_where, v_sort_col, v_dir, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  v_where := fn_agent_where(p_source, p_filters);
  perform fn_nestloop_guard(v_where);
  v_order := fn_agent_order(p_filters, p_sort_by, p_sort_dir);

  -- A5 phase 3: when every selected MLS has near-complete stats coverage, the table
  -- shows (and sorts by) THAT MLS's numbers — same gate as fn_agent_where's filters.
  if jsonb_array_length(coalesce(p_filters->'mls'->'include', '[]'::jsonb)) > 0 then
    sel_mls := array(select (jsonb_array_elements_text(p_filters->'mls'->'include'))::uuid);
    select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false)
      into scoped from mls where id = any(sel_mls);
    scoped := coalesce(scoped, false);
  end if;

  if scoped then
    -- A5 scoped branch only: keep the planner off nested loops.
    --
    -- This branch left-joins agents to a per-agent aggregate of agent_mls_stats, and the WHERE
    -- carries two more agent_mls_stats subqueries (the MLS membership semi-join, and the sales
    -- volume filter, which becomes "id in (select agent_id ... group by agent_id having
    -- sum(...))" once an MLS is selected). None of those are estimable: the location filter is
    -- an OR across three column pairs wrapped in coalesce/fn_city_embedded_state, and the title
    -- filter is fn_title_tokens(title) && array. The planner has no statistics for expressions
    -- like those, so selectivities multiply as if independent and the estimate collapses.
    --
    -- Reported by the client as "stuck for 20 seconds" on Location + Sales volume + Office
    -- search + MLS + Title. Measured: estimate 3 rows, actual 160, and it chose a nested loop
    -- against the grouped agent_mls_stats subquery -- one grouped aggregate lookup per outer
    -- row. The count alone ran past 120 s. With nested loops off it is 606 ms; the same query
    -- through fn_filter_search, 2.1 s.
    --
    -- Extended statistics were tried first (stx_agents_office_geo and friends, still in place
    -- and useful elsewhere) -- they did not help here, because the problem is expression
    -- predicates rather than cross-column correlation.
    --
    -- Checked against every scoped combination before shipping; hash/merge plans were faster or
    -- within noise in all of them, so nothing trades away for this:
    --     MLS only        826 -> 693 ms      MLS + city    278 -> 289 ms
    --     MLS + volume  1,070 -> 699 ms      MLS + brand   435 -> 365 ms
    --     MLS + title     465 -> 462 ms      FULL SET    >60,000 -> 2,099 ms
    --
    -- The scoped branch always left-joins the grouped agent_mls_stats aggregate, and that join
    -- lives in the SELECT rather than the WHERE -- so fn_nestloop_guard's inspection of v_where
    -- does not see it. Fire the guard unconditionally here. (Missing this cost MLS-only
    -- searches 693 -> 3,897 ms in testing.)
    perform set_config('enable_nestloop', 'off', true);
    v_sc := format($sc$(select agent_id,
        sum(sales_volume) as sales_volume, sum(buy_side_dollar) as buy_side_dollar,
        sum(list_side_dollar) as list_side_dollar, sum(approx_gci) as approx_gci,
        sum(closed_transactions) as closed_transactions, sum(units) as units,
        sum(buy_side_count) as buy_side_count, sum(list_side_count) as list_side_count,
        sum(closed_rentals) as closed_rentals,
        case when sum(units) > 0 then sum(coalesce(avg_sale_price, 0) * coalesce(units, 0)) / sum(units) end as avg_sale_price,
        case when sum(closed_rentals) > 0 then sum(coalesce(avg_rental_price, 0) * coalesce(closed_rentals, 0)) / sum(closed_rentals) end as avg_rental_price,
        case when sum(prev_sales_volume) > 0 then (sum(sales_volume) - sum(prev_sales_volume)) / sum(prev_sales_volume) * 100 end as pct_change
      from agent_mls_stats where mls_id = any(%L::uuid[]) group by agent_id)$sc$, sel_mls);
    -- scoped sort for production columns; everything else keeps the normal order
    v_scord := case coalesce(p_sort_by, 'sales_volume')
      when 'sales_volume' then 'sales_volume' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
      when 'closed_transactions' then 'closed_transactions' when 'approx_gci' then 'approx_gci'
      when 'buy_side_dollar' then 'buy_side_dollar' when 'list_side_dollar' then 'list_side_dollar'
      when 'buy_side_count' then 'buy_side_count' when 'list_side_count' then 'list_side_count'
      when 'closed_rentals' then 'closed_rentals' when 'avg_rental_price' then 'avg_rental_price'
      when 'pct_change' then 'pct_change' else null end;
    if v_scord is not null then
      v_order := format('sc.%I %s nulls last', v_scord, case lower(coalesce(p_sort_dir, 'desc')) when 'asc' then 'asc' else 'desc' end);
    end if;
    -- The WHERE is applied to agents BEFORE the sc join, not after it. sc exposes the same
    -- metric names agents does (sales_volume, units, closed_transactions, approx_gci,
    -- buy_side_dollar, ...), and a saved view inlines its conditions using BARE column names,
    -- so with both relations in scope a view's "sales_volume <= 4000000" was ambiguous and the
    -- whole search failed with a SQL error -- 5 of 16 live saved views, the moment an MLS filter
    -- was also selected. Filtering first leaves only agents in scope.
    execute format('select count(*), coalesce(sum(sc.sales_volume), 0) from (select a.id from agents a where %s) a left join %s sc on sc.agent_id = a.id', v_where, v_sc)
      into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select to_jsonb(a)
            || case when sc.agent_id is null
                 then jsonb_build_object('sales_volume', null, 'buy_side_dollar', null, 'list_side_dollar', null,
                        'approx_gci', null, 'closed_transactions', null, 'units', null, 'buy_side_count', null,
                        'list_side_count', null, 'closed_rentals', null, 'avg_sale_price', null,
                        'avg_rental_price', null, 'pct_change', null)
                 else to_jsonb(sc) - 'agent_id' end
            || jsonb_build_object('mls_scoped', true,
                 'mls', (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
                           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id),
                 'source_stats', (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
                                    from agent_source_stats s where s.agent_id = a.id),
                 'client_campaigns', (select string_agg(distinct c.client_name, ', ' order by c.client_name)
                                        from bison_client_leads b join orch_clients c on c.id = b.client_id
                                       where b.agent_id = a.id),
                 'campaign_count', (select count(distinct b5.campaign_id) from bison_client_leads b5 where b5.agent_id = a.id),
                 'has_replied', exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id),
                 'has_bounced', exists(select 1 from bison_client_leads b4 where b4.agent_id = a.id and b4.bounced)) as t
        from (select a.* from agents a where %s) a left join %s sc on sc.agent_id = a.id order by %s, a.id limit %s offset %s
      ) t $q$, v_where, v_sc, v_order, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  -- A12: sort by client campaign — the per-agent campaign list is aggregated ONCE
  -- (50k rows) and hash-joined, never computed per row in the sort.
  -- Retired: fn_agent_page_ids now sorts client_campaigns on the narrow path together with the
  -- other computed sorts, so this branch is no longer reached. Sorting by Client campaign still
  -- works and is far faster; the only visible change is that ties break on a.id rather than
  -- sales_volume, which makes paging deterministic. Left in place rather than deleted.
  if false and p_sort_by = 'client_campaigns' and not scoped then
    execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select a.*,
          (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
             from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
          (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
             from agent_source_stats s where s.agent_id = a.id) as source_stats,
          cc.cn as client_campaigns,
          (select count(distinct b5.campaign_id) from bison_client_leads b5 where b5.agent_id = a.id) as campaign_count,
          exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
          exists(select 1 from bison_client_leads b4 where b4.agent_id = a.id and b4.bounced) as has_bounced
        from agents a
        left join (select b.agent_id, string_agg(distinct c.client_name, ', ' order by c.client_name) as cn
                     from bison_client_leads b join orch_clients c on c.id = b.client_id
                    where b.agent_id is not null group by b.agent_id) cc on cc.agent_id = a.id
        where %s order by cc.cn %s nulls last, a.sales_volume desc nulls last, a.id limit %s offset %s
      ) t $q$, v_where, case lower(coalesce(p_sort_dir, 'asc')) when 'desc' then 'desc' else 'asc' end, p_limit, p_offset) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  execute format('select count(*), coalesce(sum(sales_volume), 0) from agents a where %s', v_where) into v_count, v_volume;

  -- Phase B/C: the page of ids is resolved by fn_agent_page_ids, which sorts a NARROW
  -- (id, sort key) set and joins the 20 survivors back, instead of dragging 1.1M
  -- full-width rows -- every column plus five correlated subqueries -- through the sort.
  -- With a top-bar term it additionally answers the relevance ordering as bounded
  -- per-group queries rather than sorting on a computed expression.
  --
  -- Measured on an unfiltered page: the sort is 540 ms narrow vs ~1,160 ms wide, and drops
  -- to 1.9 ms once the sort column has a matching DESC NULLS LAST index. Row shaping for
  -- the 20 ids is 0.85 ms. What remains is the count+sum aggregate above, ~315 ms.
  --
  -- has_replied deliberately stays on the old path below: it sorts by a computed EXISTS
  -- expression that fn_agent_sort_col has no case for, so routing it here would silently
  -- re-sort the table by sales_volume instead.
  --
  -- This also gives every agent sort the a.id tiebreaker it never had, so pages can no
  -- longer repeat or skip rows where the sort column ties.
  -- has_replied was excluded here because fn_agent_sort_col has no case for it, so routing it
  -- through would have silently re-sorted by sales_volume. fn_agent_page_ids now resolves all
  -- four computed sorts explicitly (Replied / Bounced / Client campaign / Campaigns) from one
  -- shared aggregate, so every sort takes the narrow path. The wide-row query further down is
  -- retained as a fallback but is no longer reached.
  if true then
    v_page := fn_agent_page_ids(p_source, p_filters, p_sort_by, p_sort_dir, p_limit, p_offset);
    execute format($q$
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select a.*,
          (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
             from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
          (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
             from agent_source_stats s where s.agent_id = a.id) as source_stats,
          (select string_agg(distinct c.client_name, ', ' order by c.client_name)
             from bison_client_leads b join orch_clients c on c.id = b.client_id
            where b.agent_id = a.id) as client_campaigns,
          (select count(distinct b5.campaign_id) from bison_client_leads b5 where b5.agent_id = a.id) as campaign_count,
          exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
          exists(select 1 from bison_client_leads b4 where b4.agent_id = a.id and b4.bounced) as has_bounced
        from unnest(%L::uuid[]) with ordinality u(id, ord) join agents a on a.id = u.id
       order by u.ord
      ) t $q$, v_page) into v_data;
    return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
  end if;

  execute format($q$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select a.*,
        (select jsonb_agg(jsonb_build_object('code', m.code, 'name', m.name, 'member_id', am.mls_member_id) order by m.code)
           from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls,
        (select jsonb_agg((to_jsonb(s) - 'agent_id') order by s.source)
           from agent_source_stats s where s.agent_id = a.id) as source_stats,
        (select string_agg(distinct c.client_name, ', ' order by c.client_name)
           from bison_client_leads b join orch_clients c on c.id = b.client_id
          where b.agent_id = a.id) as client_campaigns,
        (select count(distinct b5.campaign_id) from bison_client_leads b5 where b5.agent_id = a.id) as campaign_count,
        exists(select 1 from v_replied_agents r3 where r3.agent_id = a.id) as has_replied,
        exists(select 1 from bison_client_leads b4 where b4.agent_id = a.id and b4.bounced) as has_bounced
      from agents a where %s order by %s limit %s offset %s
    ) t $q$, v_where, v_order, p_limit, p_offset) into v_data;
  return jsonb_build_object('data', v_data, 'totalCount', v_count, 'salesVolumeTotal', v_volume);
end;
$function$

;

