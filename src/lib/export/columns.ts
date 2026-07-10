// Shared export column definitions — used by the Export popup (checkboxes),
// the CSV route, and the Clay send (labeled payload), so all three agree.

type Row = Record<string, unknown>;
const mlsArr = (r: Row) => (Array.isArray(r.mls) ? (r.mls as { code: string | null; member_id: string | null }[]) : []);

// ---- display formatters (export values are human-facing strings) ----
const toNum = (v: unknown): number => (typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v));
const money = (v: unknown): string => {
  const n = toNum(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "";
};
const pctFmt = (v: unknown): string => {
  const n = toNum(v);
  return Number.isFinite(n) ? `${n}%` : ""; // "98%" / "-98%"
};
const yrsMos = (v: unknown): string => {
  const n = toNum(v);
  if (!Number.isFinite(n)) return "";
  const months = Math.round(n);
  const y = Math.floor(months / 12);
  const mo = months % 12;
  if (y && mo) return `${y} yrs ${mo} mos`;
  if (y) return `${y} yrs`;
  return `${mo} mos`;
};
// Candidate (profile) URL lives inside source_ids per source; Courted has it for everyone.
const candidateUrl = (r: Row): string => {
  const s = r.source_ids as Record<string, { profile_url?: string } | undefined> | null | undefined;
  if (!s || typeof s !== "object") return "";
  return s.courted?.profile_url || s.realtor?.profile_url || s.zillow?.profile_url || "";
};

export interface ExportCol {
  key: string;
  label: string;
}

export const EXPORT_COLUMNS: ExportCol[] = [
  { key: "full_name", label: "Agent" },
  { key: "candidate_url", label: "Candidate URL" },
  { key: "office_name", label: "Office" },
  { key: "est_time_in_industry", label: "Est. time in industry" },
  { key: "license_number", label: "License number" },
  { key: "mls_affiliation", label: "MLS affiliation" },
  { key: "mls_id", label: "MLS ID" },
  { key: "home_city", label: "Home city" },
  { key: "home_zip", label: "Home zip" },
  { key: "brand", label: "Brand" },
  { key: "office_city", label: "Office city" },
  { key: "office_zip", label: "Office zip" },
  { key: "est_time_at_office", label: "Est. time at office" },
  { key: "avg_time_at_office", label: "Avg. time at office" },
  { key: "most_transacted_city", label: "Most transacted city" },
  { key: "sales_volume", label: "Sales volume" },
  { key: "pct_change", label: "% Change" },
  { key: "buy_side_dollar", label: "Buy-side ($)" },
  { key: "list_side_dollar", label: "List-side ($)" },
  { key: "approx_gci", label: "Approx. GCI ($)" },
  { key: "avg_sale_price", label: "Avg. sales price" },
  { key: "closed_transactions", label: "Closed transactions" },
  { key: "units", label: "Units" },
  { key: "buy_side_count", label: "Buy-side (#)" },
  { key: "list_side_count", label: "List-side (#)" },
  { key: "closed_rentals", label: "Closed rentals" },
  { key: "avg_rental_price", label: "Avg. rental price" },
  { key: "preferred_email", label: "Preferred email" },
  { key: "preferred_phone", label: "Preferred phone" },
  // Zillow/Realtor-only fields (all-time stats + extras)
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "languages", label: "Languages" },
  { key: "total_sales_all_time", label: "Total sales (all time)" },
  { key: "avg_price_all_time", label: "Avg. price (all time)" },
  { key: "avg_sales_volume_all_time", label: "Avg. sales volume (all time)" },
  { key: "price_range", label: "Price range" },
  { key: "other_licenses", label: "Other licenses" },
];

export const EXPORT_VALUE: Record<string, (r: Row) => unknown> = {
  full_name: (r) => r.full_name,
  candidate_url: (r) => candidateUrl(r),
  office_name: (r) => r.office_name,
  est_time_in_industry: (r) => r.est_time_in_industry_raw,
  license_number: (r) => r.license_number,
  mls_affiliation: (r) => mlsArr(r).map((m) => m.code).filter(Boolean).join(" | "),
  mls_id: (r) => mlsArr(r).map((m) => m.member_id).filter(Boolean).join(" | "),
  home_city: (r) => r.home_city,
  home_zip: (r) => r.home_zip,
  brand: (r) => r.brand,
  office_city: (r) => r.office_city,
  office_zip: (r) => r.office_zip,
  est_time_at_office: (r) => yrsMos(r.est_time_at_office_months),
  avg_time_at_office: (r) => yrsMos(r.avg_time_at_office_months),
  most_transacted_city: (r) => r.most_transacted_city,
  sales_volume: (r) => money(r.sales_volume),
  pct_change: (r) => pctFmt(r.pct_change),
  buy_side_dollar: (r) => money(r.buy_side_dollar),
  list_side_dollar: (r) => money(r.list_side_dollar),
  approx_gci: (r) => money(r.approx_gci),
  avg_sale_price: (r) => money(r.avg_sale_price),
  closed_transactions: (r) => r.closed_transactions,
  units: (r) => r.units,
  buy_side_count: (r) => r.buy_side_count,
  list_side_count: (r) => r.list_side_count,
  closed_rentals: (r) => r.closed_rentals,
  avg_rental_price: (r) => money(r.avg_rental_price),
  preferred_email: (r) => r.preferred_email,
  preferred_phone: (r) => r.preferred_phone,
  linkedin_url: (r) => r.linkedin_url,
  languages: (r) => (Array.isArray(r.languages) ? (r.languages as string[]).join(" | ") : ""),
  total_sales_all_time: (r) => r.total_sales_all_time,
  avg_price_all_time: (r) => money(r.avg_price_all_time),
  avg_sales_volume_all_time: (r) => money(r.avg_sales_volume_all_time),
  price_range: (r) => r.price_range,
  other_licenses: (r) => r.other_licenses,
};

// Canonical-ordered, validated subset of keys (defaults to all when none chosen).
export function orderedKeys(keys?: string[] | null): string[] {
  const all = EXPORT_COLUMNS.map((c) => c.key);
  if (!keys || keys.length === 0) return all;
  return all.filter((k) => keys.includes(k));
}

// Reshape a raw agent row into a labeled object with only the chosen columns.
export function buildLabeledRow(r: Row, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of EXPORT_COLUMNS) {
    if (keys.includes(c.key) && EXPORT_VALUE[c.key]) out[c.label] = EXPORT_VALUE[c.key](r);
  }
  return out;
}
