export interface AgentMls {
  code: string | null;
  name: string | null;
  member_id: string | null;
}

export interface Agent {
  id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  license_number: string | null;
  preferred_email: string | null;
  preferred_phone: string | null;
  brand: string | null;
  office_name: string | null;
  est_time_in_industry_raw: string | null;
  est_time_in_industry_months: number | null;
  est_time_at_office_months: number | null;
  avg_time_at_office_months: number | null;
  home_city: string | null;
  home_zip: string | null;
  home_state: string | null;
  office_city: string | null;
  office_state: string | null;
  office_zip: string | null;
  most_transacted_city: string | null;
  transacted_state: string | null;
  sales_volume: number | null;
  pct_change: number | null;
  list_side_dollar: number | null;
  buy_side_dollar: number | null;
  approx_gci: number | null;
  avg_sale_price: number | null;
  closed_transactions: number | null;
  units: number | null;
  buy_side_count: number | null;
  list_side_count: number | null;
  closed_rentals: number | null;
  avg_rental_price: number | null;
  active_listings: number | null;
  pending_listings: number | null;
  // Zillow/Realtor-only fields (all-time stats + extras — separate from LTM metrics)
  linkedin_url?: string | null;
  languages?: string[] | null;
  total_sales_all_time?: number | null;
  avg_price_all_time?: number | null;
  avg_sales_volume_all_time?: number | null;
  price_range?: string | null;
  other_licenses?: string | null;
  mls: AgentMls[] | null;
  // one entry per matched source with EVERY agent_source_stats metric (see migration 0019)
  source_stats?: ({ source: string } & Record<string, number | string | null>)[] | null;
  // office-mode rows (when mode = "office")
  agent_names?: string[] | null;
  agent_count?: number | null;
  [key: string]: unknown;
}

export type SortDir = "asc" | "desc";
export type SearchMode = "agent" | "office";
export type DataSource = "all" | "courted" | "zillow_realtor";

export interface SearchResponse {
  data: Agent[];
  totalCount: number;
  salesVolumeTotal: number;
}
