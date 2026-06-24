// Filter state for the Agent Search screen. Maps 1:1 to fn_filter_search's p_filters.

export type LocationField = "city" | "zip" | "county" | "state";
export type LocationKind = "office" | "home" | "transacted";
export type VolumeSide = "all" | "list" | "buy";

export interface IncludeExclude {
  include: string[];
  exclude: string[];
}
export interface LocationFilter {
  field: LocationField;
  appliesTo: LocationKind[];
  values: string[];
}
export interface RangeSide {
  side: VolumeSide;
  buckets: string[];
  min: string;
  max: string;
}
export interface RangeF {
  buckets: string[];
  min: string;
  max: string;
}
export interface OfficeSearchFilter {
  brand: IncludeExclude;
  office: IncludeExclude;
}

export interface Filters {
  location: LocationFilter;
  salesVolume: RangeSide;
  closedUnits: RangeSide;
  closedTransactions: RangeSide;
  estTimeInIndustry: RangeF;
  approxGci: RangeF;
  officeSearch: OfficeSearchFilter;
  mls: IncludeExclude; // mls ids
  title: IncludeExclude;
}

export const DEFAULT_FILTERS: Filters = {
  location: { field: "city", appliesTo: ["office", "home", "transacted"], values: [] },
  salesVolume: { side: "all", buckets: [], min: "", max: "" },
  closedUnits: { side: "all", buckets: [], min: "", max: "" },
  closedTransactions: { side: "all", buckets: [], min: "", max: "" },
  estTimeInIndustry: { buckets: [], min: "", max: "" },
  approxGci: { buckets: [], min: "", max: "" },
  officeSearch: { brand: { include: [], exclude: [] }, office: { include: [], exclude: [] } },
  mls: { include: [], exclude: [] },
  title: { include: [], exclude: [] },
};

// Bucket sets: { key } is sent to the RPC (must match fn_bucket_cond); { label } is displayed.
export interface Bucket {
  key: string;
  label: string;
}
export const SALES_VOLUME_BUCKETS: Bucket[] = [
  { key: "$0-5M", label: "$0 - $5M" },
  { key: "$5-10M", label: "$5M - $10M" },
  { key: "$10-20M", label: "$10M - $20M" },
  { key: "$20-50M", label: "$20M - $50M" },
  { key: "$50-100M", label: "$50M - $100M" },
  { key: "$100M+", label: "$100M+" },
];
export const COUNT_BUCKETS: Bucket[] = [
  { key: "1-5", label: "1 - 5" },
  { key: "5-10", label: "5 - 10" },
  { key: "10-20", label: "10 - 20" },
  { key: "20+", label: "20+" },
];
export const YEAR_BUCKETS: Bucket[] = [
  { key: "0-1yr", label: "0 - 1 yr" },
  { key: "1-3yrs", label: "1 - 3 yrs" },
  { key: "3-5yrs", label: "3 - 5 yrs" },
  { key: "5-10yrs", label: "5 - 10 yrs" },
  { key: "10+yrs", label: "10+ yrs" },
];
export const GCI_BUCKETS: Bucket[] = [
  { key: "$0-100K", label: "$0 - $100K" },
  { key: "$100-250K", label: "$100K - $250K" },
  { key: "$250-500K", label: "$250K - $500K" },
  { key: "$500K-1M", label: "$500K - $1M" },
  { key: "$1M+", label: "$1M+" },
];
export const TITLES = ["Salesperson", "Team Leader", "Managing Broker"];

// active-count helpers
export const ieCount = (ie: IncludeExclude) => ie.include.length + ie.exclude.length;
export const rangeCount = (r: { buckets: string[]; min: string; max: string }) =>
  r.buckets.length + (r.min ? 1 : 0) + (r.max ? 1 : 0);
export const officeSearchCount = (o: OfficeSearchFilter) => ieCount(o.brand) + ieCount(o.office);
