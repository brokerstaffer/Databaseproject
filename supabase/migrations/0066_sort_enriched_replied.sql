-- 0066 (A11): sort by Enriched (enriched_at) and Replied (hashed IN over the replied set).

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
  || case when p_sort_by = 'has_replied' then
       -- computed flag: hashed IN over the (small) replied set — never a per-row subquery sort
       format('(a.id in (select agent_id from bison_client_leads where replied and agent_id is not null)) %s, sales_volume desc nulls last',
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
$function$;

grant execute on function fn_agent_order(jsonb, text, text) to anon, authenticated;
