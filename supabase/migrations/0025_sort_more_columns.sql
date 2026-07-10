-- 0025_sort_more_columns.sql
-- Extend fn_agent_order's sort allowlist so every scalar table column is sortable
-- (adds preferred_email/phone and the all-time Zillow/Realtor stat columns).
create or replace function fn_agent_order(p_filters jsonb, p_sort_by text, p_sort_dir text) returns text
language sql immutable as $$
  select case when coalesce(p_filters->>'nameQuery', '') <> ''
    then format('(full_name ilike %L) desc, ', '%' || (p_filters->>'nameQuery') || '%') else '' end
  || format('%I %s nulls last',
       case p_sort_by
         when 'full_name' then 'full_name' when 'units' then 'units' when 'avg_sale_price' then 'avg_sale_price'
         when 'closed_transactions' then 'closed_transactions' when 'est_time_in_industry_months' then 'est_time_in_industry_months'
         when 'license_number' then 'license_number' when 'office_name' then 'office_name'
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
         else 'sales_volume' end,
       case lower(p_sort_dir) when 'asc' then 'asc' else 'desc' end);
$$;
grant execute on function fn_agent_order(jsonb, text, text) to anon, authenticated;
