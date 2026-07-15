"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Agent, SearchResponse, SortDir, SearchMode, DataSource } from "@/types/agent";
import { RangePopover, TitlePopover, ClientPopover, ZillowRealtorPopover, MissingContactPopover } from "./agent-filters";
import { LocationPopover, OfficeSearchPopover, MlsPopover, LicensePopover, NamePopover } from "./agent-typeahead-filters";
import { ExportDialog } from "./export-dialog";
import { SavedViews } from "./saved-views";
import { EditColumnsModal } from "./edit-columns";
import { AllFiltersDrawer } from "./all-filters-drawer";
import { OfficeProfile } from "./office-profile";
import { DEFAULT_FILTERS, SALES_VOLUME_BUCKETS, COUNT_BUCKETS, YEAR_BUCKETS, GCI_BUCKETS, activeFilterCount, normalizeFilters } from "@/types/agent-filters";
import type { Filters } from "@/types/agent-filters";
import { useNameSearch } from "@/lib/stores/name-search";

const PAGE_SIZES = [20, 50, 100];

// ---------- formatters ----------
function usdShort(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  const f = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e9) return `$${f(n / 1e9, 1)}B`; // "$1,426.1B"
  if (a >= 1e6) return `$${f(n / 1e6, 1)}M`;
  if (a >= 1e3) return `$${f(n / 1e3, 0)}K`;
  return `$${f(n, 0)}`;
}
const usd = (n: number | null | undefined) => (n == null ? "N/A" : "$" + Math.round(n).toLocaleString());
const numv = (n: number | null | undefined) => (n == null ? "N/A" : n.toLocaleString());
const na = (s: string | null | undefined) => (s == null || s === "" ? "N/A" : s);
const phoneFmt = (s: string | null | undefined) => (s == null || s === "" ? "None" : s);
// Does this agent's name contain the top-bar search term? (case-insensitive) — drives the highlight.
function nameMatches(name: string | null | undefined, term: string): boolean {
  return !!term && !!name && name.toLowerCase().includes(term.toLowerCase());
}
function ym(m: number | null | undefined): string {
  if (m == null) return "N/A";
  const months = Math.round(m);
  const y = Math.floor(months / 12);
  const mo = months % 12;
  if (y && mo) return `${y} yrs ${mo} mos`;
  if (y) return `${y} yrs`;
  return `${mo} mos`;
}
function PctChange({ n }: { n: number | null | undefined }) {
  if (n == null) return <span className="text-neutral-400">N/A</span>;
  return <span className={n >= 0 ? "text-emerald-600" : "text-red-600"}>{`${n >= 0 ? "+" : ""}${n.toLocaleString()}%`}</span>;
}
// Metric cell with a per-source breakdown when the agent is matched across sources AND the
// sources disagree. Identical values collapse to the single number; a source missing the
// metric shows as N/A (matches the Courted-style reference screenshot).
function StatCell({ a, field, fmt }: { a: Agent; field: string; fmt: (v: number | null | undefined) => React.ReactNode }) {
  const stats = a.source_stats ?? [];
  let breakdown: typeof stats = [];
  if (stats.length > 1) {
    const uniq = new Set(stats.map((s) => JSON.stringify(s[field] ?? null)));
    if (uniq.size > 1) breakdown = stats; // values differ (incl. value vs N/A) -> show all
  }
  return (
    <div>
      <div>{fmt(a[field] as number | null | undefined)}</div>
      {breakdown.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {breakdown.map((s) => (
            <div key={s.source} className="text-[11px] capitalize text-neutral-400">
              {s.source}: {fmt(s[field] as number | null | undefined)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Col {
  key: string;
  label: string;
  sortBy?: string;
  // First click on this header sorts this direction (default "desc"). Text columns like MLS /
  // LinkedIn use "asc" so the first click gives A-Z.
  defaultDir?: SortDir;
  align?: "right";
  render: (a: Agent) => React.ReactNode;
}

// Courted default 28-column order.
// mls codes/ids joined — an agent can belong to several MLSs (dedup keeps them all)
const mlsCodes = (a: Agent) => a.mls?.map((m) => m.code).filter(Boolean).join(" | ") || "N/A";
const mlsIds = (a: Agent) => a.mls?.map((m) => m.member_id).filter(Boolean).join(" | ") || "N/A";

const COLUMNS: Col[] = [
  { key: "agent", label: "Agent", sortBy: "full_name", render: (a) => <span className="font-semibold text-neutral-900">{na(a.full_name)}</span> },
  { key: "office", label: "Office", sortBy: "office_name", render: (a) => na(a.office_name) },
  { key: "timeInd", label: "Est. time in industry", sortBy: "est_time_in_industry_months", render: (a) => a.est_time_in_industry_raw ?? "N/A" },
  { key: "license", label: "License number", sortBy: "license_number", render: (a) => na(a.license_number) },
  { key: "mlsAff", label: "MLS affiliation", sortBy: "mls", defaultDir: "asc", render: (a) => mlsCodes(a) },
  { key: "mlsId", label: "MLS ID", render: (a) => mlsIds(a) },
  { key: "homeCity", label: "Home city", sortBy: "home_city", render: (a) => (a.home_city ? `${a.home_city}${a.home_state ? `, ${a.home_state}` : ""}` : "N/A") },
  { key: "homeZip", label: "Home zip", sortBy: "home_zip", render: (a) => na(a.home_zip) },
  { key: "brand", label: "Brand", sortBy: "brand", render: (a) => na(a.brand) },
  { key: "officeCity", label: "Office city", sortBy: "office_city", render: (a) => (a.office_city ? `${a.office_city}${a.office_state ? `, ${a.office_state}` : ""}` : "N/A") },
  { key: "officeZip", label: "Office zip code", sortBy: "office_zip", render: (a) => na(a.office_zip) },
  { key: "timeOffice", label: "Est. time at office", sortBy: "est_time_at_office_months", render: (a) => ym(a.est_time_at_office_months) },
  { key: "avgTimeOffice", label: "Avg. time at office", sortBy: "avg_time_at_office_months", render: (a) => ym(a.avg_time_at_office_months) },
  { key: "transacted", label: "Most transacted city", sortBy: "most_transacted_city", render: (a) => (a.most_transacted_city ? `${a.most_transacted_city}${a.transacted_state ? `, ${a.transacted_state}` : ""}` : "N/A") },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (a) => <StatCell a={a} field="sales_volume" fmt={usd} /> },
  { key: "pct", label: "% Change", sortBy: "pct_change", align: "right", render: (a) => <StatCell a={a} field="pct_change" fmt={(n) => <PctChange n={n} />} /> },
  { key: "buy$", label: "Buy-side ($)", sortBy: "buy_side_dollar", align: "right", render: (a) => <StatCell a={a} field="buy_side_dollar" fmt={usd} /> },
  { key: "list$", label: "List-side ($)", sortBy: "list_side_dollar", align: "right", render: (a) => <StatCell a={a} field="list_side_dollar" fmt={usd} /> },
  { key: "gci", label: "Approx. GCI", sortBy: "approx_gci", align: "right", render: (a) => <StatCell a={a} field="approx_gci" fmt={usd} /> },
  { key: "avgPrice", label: "Avg. sales price", sortBy: "avg_sale_price", align: "right", render: (a) => <StatCell a={a} field="avg_sale_price" fmt={usd} /> },
  { key: "closedTx", label: "Closed transactions", sortBy: "closed_transactions", align: "right", render: (a) => <StatCell a={a} field="closed_transactions" fmt={numv} /> },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (a) => <StatCell a={a} field="units" fmt={numv} /> },
  { key: "buyN", label: "Buy-side (#)", sortBy: "buy_side_count", align: "right", render: (a) => <StatCell a={a} field="buy_side_count" fmt={numv} /> },
  { key: "listN", label: "List-side (#)", sortBy: "list_side_count", align: "right", render: (a) => <StatCell a={a} field="list_side_count" fmt={numv} /> },
  { key: "rentals", label: "Closed rentals", sortBy: "closed_rentals", align: "right", render: (a) => <StatCell a={a} field="closed_rentals" fmt={numv} /> },
  { key: "avgRent", label: "Avg. rental price", sortBy: "avg_rental_price", align: "right", render: (a) => <StatCell a={a} field="avg_rental_price" fmt={usd} /> },
  { key: "email", label: "Preferred email address", sortBy: "preferred_email", render: (a) => na(a.preferred_email) },
  { key: "phone", label: "Preferred phone number", sortBy: "preferred_phone", render: (a) => phoneFmt(a.preferred_phone) },
  // Zillow/Realtor-only fields (all-time stats + extras — separate from the LTM metrics)
  { key: "linkedin", label: "LinkedIn", sortBy: "linkedin_url", defaultDir: "asc", render: (a) => {
      if (!a.linkedin_url) return <span className="text-neutral-400">N/A</span>;
      const url = String(a.linkedin_url);
      return <a href={/^https?:\/\//i.test(url) ? url : `https://${url}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Profile</a>;
    } },
  { key: "languages", label: "Languages", render: (a) => ((a.languages as string[] | null)?.length ? (a.languages as string[]).join(", ") : "N/A") },
  { key: "totalSalesAT", label: "Total sales (all time)", sortBy: "total_sales_all_time", align: "right", render: (a) => numv(a.total_sales_all_time as number | null) },
  { key: "avgPriceAT", label: "Avg. price (all time)", sortBy: "avg_price_all_time", align: "right", render: (a) => usd(a.avg_price_all_time as number | null) },
  { key: "avgVolAT", label: "Avg. sales volume (all time)", sortBy: "avg_sales_volume_all_time", align: "right", render: (a) => usd(a.avg_sales_volume_all_time as number | null) },
  { key: "priceRange", label: "Price range", render: (a) => na(a.price_range as string | null) },
  { key: "otherLic", label: "Other licenses", render: (a) => na(a.other_licenses as string | null) },
];

const DEFAULT_COL_ORDER = COLUMNS.map((c) => c.key);
const COL_BY_KEY: Record<string, Col> = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const COL_META = COLUMNS.map((c) => ({ key: c.key, label: c.label }));
const LOCKED_COLS = ["agent", "office"];
const COLS_STORAGE = "bs_agent_cols";

// Office-mode columns (offices table + the office's agents).
const OFFICE_COLUMNS: Col[] = [
  { key: "office", label: "Office", sortBy: "office_name", render: (o) => <span className="font-semibold text-neutral-900">{na(o.office_name)}</span> },
  { key: "brand", label: "Brand", render: (o) => na(o.brand) },
  { key: "officeCity", label: "Office city", render: (o) => (o.office_city ? `${o.office_city}${o.office_state ? `, ${o.office_state}` : ""}` : "N/A") },
  { key: "officeZip", label: "Office zip", render: (o) => na(o.office_zip) },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (o) => usd(o.sales_volume) },
  { key: "list$", label: "List-side ($)", align: "right", render: (o) => usd(o.list_side_dollar) },
  { key: "buy$", label: "Buy-side ($)", align: "right", render: (o) => usd(o.buy_side_dollar) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (o) => numv(o.units) },
  { key: "agentCount", label: "Agents", sortBy: "agent_count", align: "right", render: (o) => numv(o.agent_count) },
  {
    key: "agents",
    label: "Agents at office",
    render: (o) => {
      const names = o.agent_names ?? [];
      if (names.length === 0) return <span className="text-neutral-400">N/A</span>;
      const shown = names.slice(0, 4).join(", ");
      const extra = names.length > 4 ? ` +${names.length - 4}` : "";
      return <span className="text-neutral-600">{shown}{extra}</span>;
    },
  },
];

// Which table columns each ACTIVE filter acts on — those headers get a light-gray tint so it's
// obvious at a glance which columns are being filtered. Keys match COLUMNS / OFFICE_COLUMNS.
function highlightedColumns(f: Filters, mode: SearchMode): Set<string> {
  const s = new Set<string>();
  const active = (r: { buckets: string[]; min: string; max: string }) => r.buckets.length > 0 || !!r.min || !!r.max;
  const ie = (x: { include: string[]; exclude: string[] }) => x.include.length > 0 || x.exclude.length > 0;

  if (f.location.values.length > 0) {
    const zip = f.location.field === "zip";
    if (mode === "office") {
      s.add(zip ? "officeZip" : "officeCity");
    } else {
      for (const k of f.location.appliesTo) {
        if (k === "office") s.add(zip ? "officeZip" : "officeCity");
        else if (k === "home") s.add(zip ? "homeZip" : "homeCity");
        else if (k === "transacted") s.add("transacted");
      }
    }
  }
  if (active(f.salesVolume)) s.add(f.salesVolume.side === "list" ? "list$" : f.salesVolume.side === "buy" ? "buy$" : "vol");
  if (active(f.closedUnits)) s.add(f.closedUnits.side === "list" ? "listN" : f.closedUnits.side === "buy" ? "buyN" : "units");
  if (active(f.closedTransactions)) s.add(f.closedTransactions.side === "list" ? "listN" : f.closedTransactions.side === "buy" ? "buyN" : "closedTx");
  if (active(f.estTimeInIndustry)) s.add("timeInd");
  if (active(f.approxGci)) s.add("gci");
  if (active(f.avgSalePrice)) s.add("avgPrice");
  if (active(f.estTimeInOffice)) s.add("timeOffice");
  if (active(f.avgTimeAtOffice)) s.add("avgTimeOffice");
  if (mode === "office" && active(f.agentCount)) s.add("agentCount");
  if (ie(f.officeSearch.brand)) s.add("brand");
  if (ie(f.officeSearch.office)) s.add("office");
  if (ie(f.mls)) s.add("mlsAff");
  if (ie(f.license)) s.add("license");
  if (ie(f.name)) s.add("agent");
  if (f.missingContact.email) s.add("email");
  if (f.missingContact.phone) s.add("phone");
  const z = f.zillowRealtor;
  if (z.languages.length > 0) s.add("languages");
  if (z.totalSales.min || z.totalSales.max) s.add("totalSalesAT");
  if (z.avgPriceAllTime.min || z.avgPriceAllTime.max) s.add("avgPriceAT");
  if (z.avgVolumeAllTime.min || z.avgVolumeAllTime.max) s.add("avgVolAT");
  if (z.hasLinkedin) s.add("linkedin");
  return s;
}

export function AgentSearch({ initialQuery = "" }: { initialQuery?: string }) {
  const [rows, setRows] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [vol, setVol] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState("sales_volume");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [exportOpen, setExportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [allFiltersOpen, setAllFiltersOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("agent");
  const [source, setSource] = useState<DataSource>("all");
  const [profileOfficeId, setProfileOfficeId] = useState<string | null>(null);
  const [colOrder, setColOrder] = useState<string[]>(DEFAULT_COL_ORDER);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE);
      if (raw) {
        const j = JSON.parse(raw);
        const savedOrder: string[] = Array.isArray(j.order) ? j.order.filter((k: string) => COL_BY_KEY[k]) : [];
        setColOrder([...savedOrder, ...DEFAULT_COL_ORDER.filter((k) => !savedOrder.includes(k))]);
        if (Array.isArray(j.hidden)) setHiddenCols(new Set(j.hidden.filter((k: string) => !LOCKED_COLS.includes(k))));
      }
    } catch {
      /* ignore */
    }
  }, []);

  function applyCols(order: string[], hidden: string[]) {
    const cleanHidden = hidden.filter((k) => !LOCKED_COLS.includes(k));
    setColOrder(order);
    setHiddenCols(new Set(cleanHidden));
    try {
      localStorage.setItem(COLS_STORAGE, JSON.stringify({ order, hidden: cleanHidden }));
    } catch {
      /* ignore */
    }
  }

  const visibleColumns = colOrder.map((k) => COL_BY_KEY[k]).filter((c): c is Col => !!c && !hiddenCols.has(c.key));
  const activeColumns = mode === "office" ? OFFICE_COLUMNS : visibleColumns;
  const highlightTerm = (filters.nameQuery ?? "").trim();

  // (nameQuery is a find/highlight tool, not a filter, so it does not count here.)
  const filterCount = activeFilterCount(filters, mode);
  // Columns whose filter is active — their headers/cells get a light-gray tint.
  const highlightedCols = highlightedColumns(filters, mode);

  function setF<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((p) => ({ ...p, [k]: v }));
    setPage(1);
  }
  function clearAllFilters() {
    // keep column layout + the top-bar find term; reset every actual filter
    setFilters((p) => ({ ...DEFAULT_FILTERS, nameQuery: p.nameQuery }));
    setPage(1);
  }

  // Top-bar name search flows through a shared store (not the URL), so it narrows the CURRENT
  // filtered list instead of re-mounting this screen and wiping the applied filters.
  const [nameSearch, setNameSearch] = useNameSearch();
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the store from a deep-link (/search?q=…) once on mount.
  useEffect(() => {
    if (initialQuery) setNameSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the search term as the nameQuery filter (debounced), leaving all other filters intact.
  useEffect(() => {
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      setFilters((f) => (f.nameQuery === nameSearch ? f : { ...f, nameQuery: nameSearch }));
      setPage(1);
    }, 300);
    return () => {
      if (nameTimer.current) clearTimeout(nameTimer.current);
    };
  }, [nameSearch]);

  // Latest-wins: a slow "All" request can resolve after a fast "Zillow/Realtor" one and
  // overwrite it. Each fetch bumps a token and aborts the previous request; only the newest
  // response is allowed to update the table.
  const reqSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const jumpTopRef = useRef(false); // pagination should land at the top of the new page

  const fetchData = useCallback(async () => {
    const seq = ++reqSeq.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0; // remember scroll for restore
    setLoading(true);
    try {
      const res = await fetch("/api/search/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, source, sortBy, sortDir, page, pageSize, filters }),
        signal: ctrl.signal,
      });
      const json: SearchResponse = await res.json();
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      setRows(json.data ?? []);
      setTotal(json.totalCount ?? 0);
      setVol(json.salesVolumeTotal ?? 0);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [mode, source, sortBy, sortDir, page, pageSize, filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Keep the table scroll position across filter/sort changes (don't jump to the top); but a
  // page change should land at the top of the new page.
  useLayoutEffect(() => {
    if (loading || !scrollRef.current) return;
    if (jumpTopRef.current) {
      scrollRef.current.scrollTop = 0;
      jumpTopRef.current = false;
    } else {
      scrollRef.current.scrollTop = scrollTopRef.current;
    }
  }, [rows, loading]);

  function toggleSort(col: Col) {
    if (!col.sortBy) return;
    if (sortBy === col.sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col.sortBy);
      setSortDir(col.defaultDir ?? "desc");
    }
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Title + filters */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex shrink-0 items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{mode === "office" ? "Office Search" : "Agent Search"}</h1>
          <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 text-sm">
            {(["agent", "office"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (m === mode) return; // misclick on the active button must not wipe state
                  setMode(m);
                  setPage(1);
                  setSelected(new Set());
                  // office & agent modes sort on different columns — reset to the default
                  setSortBy("sales_volume");
                  setSortDir("desc");
                }}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${mode === m ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {m === "agent" ? "Agent" : "Office"}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 text-sm">
            {([["all", "All"], ["courted", "MLS"], ["zillow_realtor", "Zillow / Realtor"]] as const).map(([s, lbl]) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  if (s === source) return; // misclick on the active button must not wipe state
                  setSource(s);
                  setPage(1);
                  setSelected(new Set());
                }}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${source === s ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {filters.nameQuery && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-green-200/70 px-2.5 py-1.5 text-sm font-medium text-green-900">
              Find: “{filters.nameQuery}”
              <button type="button" onClick={() => setNameSearch("")} className="text-green-700 hover:text-green-900" aria-label="Clear name search">
                ×
              </button>
            </span>
          )}
          {/* Only the filters the current mode's query actually applies are shown — office
              mode narrows on location / volume / office / units / agent count / client. */}
          <ClientPopover value={filters.orchClientIds} clientMode={filters.orchClientMode} onChange={(ids, m) => { setFilters((p) => ({ ...p, orchClientIds: ids, orchClientMode: m })); setPage(1); }} />
          <LocationPopover value={filters.location} onChange={(v) => setF("location", v)} officeMode={mode === "office"} />
          <RangePopover label="Sales volume" hasSide prefix="$" buckets={SALES_VOLUME_BUCKETS} value={filters.salesVolume} onChange={(v) => setF("salesVolume", v)} />
          <OfficeSearchPopover value={filters.officeSearch} onChange={(v) => setF("officeSearch", v)} />
          {mode === "agent" && (
            <>
              <MlsPopover value={filters.mls} onChange={(v) => setF("mls", v)} />
              <TitlePopover value={filters.title} onChange={(v) => setF("title", v)} />
              <LicensePopover value={filters.license} onChange={(v) => setF("license", v)} />
              <NamePopover value={filters.name} onChange={(v) => setF("name", v)} />
              <MissingContactPopover value={filters.missingContact} onChange={(v) => setF("missingContact", v)} />
            </>
          )}
          {mode === "office" && (
            <RangePopover label="Agents in office" suffix="#" buckets={COUNT_BUCKETS} value={{ side: "all", ...filters.agentCount }} onChange={(v) => setF("agentCount", { buckets: v.buckets, min: v.min, max: v.max })} />
          )}
          {/* office mode always ranges on total units — the List/Buy split is agent-only */}
          <RangePopover label="Closed units" hasSide={mode === "agent"} prefix="#" buckets={COUNT_BUCKETS} value={filters.closedUnits} onChange={(v) => setF("closedUnits", v)} />
          {mode === "agent" && (
            <>
              <RangePopover label="Closed transactions" hasSide prefix="#" buckets={COUNT_BUCKETS} value={filters.closedTransactions} onChange={(v) => setF("closedTransactions", v)} />
              <RangePopover label="Est. time in industry" suffix="yrs" buckets={YEAR_BUCKETS} value={{ side: "all", ...filters.estTimeInIndustry }} onChange={(v) => setF("estTimeInIndustry", { buckets: v.buckets, min: v.min, max: v.max })} />
              <RangePopover label="Approx. GCI" prefix="$" buckets={GCI_BUCKETS} value={{ side: "all", ...filters.approxGci }} onChange={(v) => setF("approxGci", { buckets: v.buckets, min: v.min, max: v.max })} />
              <ZillowRealtorPopover value={filters.zillowRealtor ?? DEFAULT_FILTERS.zillowRealtor} onChange={(v) => setF("zillowRealtor", v)} />
            </>
          )}
          {mode === "agent" && (
            <button
              type="button"
              onClick={() => setAllFiltersOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              <SlidersHorizontal className="h-4 w-4" />
              All filters
              {filterCount > 0 && (
                <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-900 px-1.5 text-xs font-medium text-white">
                  {filterCount}
                </span>
              )}
            </button>
          )}
          {filterCount > 0 && (
            <button type="button" onClick={clearAllFilters} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800">
              <X className="h-4 w-4" />
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* White card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        {/* Count + actions */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm">
            {loading ? (
              <span className="text-neutral-500">Loading…</span>
            ) : (
              <>
                <span className="font-semibold text-neutral-900">{total.toLocaleString()}</span>
                <span className="text-neutral-500">{mode === "office" ? " Offices found" : " Agents found"}</span>
                <span className="px-2 text-neutral-300">•</span>
                <span className="font-semibold text-neutral-900">{usdShort(vol)}</span>
                <span className="text-neutral-500"> Sales volume</span>
              </>
            )}
          </p>
          <div className="flex items-center gap-1">
            <button type="button" title="Edit columns" onClick={() => setEditOpen(true)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100">
              <SlidersHorizontal className="h-[18px] w-[18px]" />
            </button>
            <button type="button" title="Export — Send to campaign / CSV" onClick={() => setExportOpen(true)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100">
              <Download className="h-[18px] w-[18px]" />
            </button>
            <SavedViews
              filters={filters}
              onLoad={(f) => {
                setFilters(normalizeFilters(f)); // fills newer keys + folds legacy orchClientId -> orchClientIds
                setNameSearch(f.nameQuery ?? ""); // keep the top-bar search box in sync with the loaded view
                setPage(1);
              }}
            />
          </div>
        </div>

        {/* Table */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-neutral-200">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-neutral-200">
                <th className="w-10 px-4 py-2.5 text-left">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all" />
                </th>
                {activeColumns.map((col) => {
                  const active = sortBy === col.sortBy;
                  return (
                    <th
                      key={col.key}
                      className={`whitespace-nowrap px-4 py-2.5 text-[13px] font-medium text-neutral-500 ${col.align === "right" ? "text-right" : "text-left"} ${highlightedCols.has(col.key) ? "bg-neutral-100" : ""}`}
                    >
                      {col.sortBy ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col)}
                          className={`inline-flex items-center gap-1 ${col.align === "right" ? "flex-row-reverse" : ""} ${active ? "text-neutral-900" : "hover:text-neutral-700"}`}
                        >
                          {col.label}
                          {active ? (
                            sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-neutral-300" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={activeColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={activeColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    No agents found.
                  </td>
                </tr>
              ) : (
                rows.map((a) => {
                  const hit = mode !== "office" && nameMatches(a.full_name, highlightTerm);
                  return (
                    <tr
                      key={a.id}
                      className={`border-b border-neutral-100 hover:bg-neutral-50 ${mode === "office" ? "cursor-pointer" : ""}`}
                      onClick={mode === "office" ? () => setProfileOfficeId(a.id) : undefined}
                    >
                      <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleOne(a.id)} aria-label="Select row" />
                      </td>
                      {activeColumns.map((col) => {
                        const cellHit = hit && col.key === "agent"; // light-green highlight on the matching name
                        return (
                          <td
                            key={col.key}
                            className={`whitespace-nowrap px-4 py-3 text-neutral-700 ${col.align === "right" ? "text-right tabular-nums" : "text-left"} ${cellHit ? "bg-green-200/70" : highlightedCols.has(col.key) ? "bg-neutral-50" : ""}`}
                          >
                            {col.render(a)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 text-sm">
          <div className="flex items-center gap-3 text-neutral-500">
            <span>Items per page</span>
            {PAGE_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (s === pageSize && page === 1) return; // no-op click must not strand the jump flag
                  jumpTopRef.current = true;
                  setPageSize(s);
                  setPage(1);
                }}
                className={s === pageSize ? "font-semibold text-neutral-900 underline underline-offset-4" : "text-neutral-500 hover:text-neutral-800"}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-neutral-600">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => { jumpTopRef.current = true; setPage((p) => p - 1); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex h-8 min-w-8 items-center justify-center rounded-md border border-neutral-200 px-2">{page}</span>
            <span className="text-neutral-500">out of {totalPages.toLocaleString()}</span>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => { jumpTopRef.current = true; setPage((p) => p + 1); }}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} filters={filters} total={total} selectedIds={Array.from(selected)} source={source} mode={mode} />
      <EditColumnsModal
        open={editOpen}
        onOpenChange={setEditOpen}
        columns={COL_META}
        locked={LOCKED_COLS}
        order={colOrder}
        hidden={[...hiddenCols]}
        defaultOrder={DEFAULT_COL_ORDER}
        onSave={applyCols}
      />
      <AllFiltersDrawer
        open={allFiltersOpen}
        onOpenChange={setAllFiltersOpen}
        filters={filters}
        onApply={(f) => {
          setFilters(f);
          setNameSearch(f.nameQuery ?? ""); // keep the top-bar search box in sync after applying the drawer
          setPage(1);
        }}
      />
      <OfficeProfile officeId={profileOfficeId} onOpenChange={(o) => { if (!o) setProfileOfficeId(null); }} />
    </div>
  );
}
