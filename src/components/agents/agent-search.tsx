"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  SlidersHorizontal,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Agent, SearchResponse, SortDir, SearchMode, DataSource } from "@/types/agent";
import { RangePopover, TitlePopover } from "./agent-filters";
import { LocationPopover, OfficeSearchPopover, MlsPopover, LicensePopover, NamePopover } from "./agent-typeahead-filters";
import { ExportDialog } from "./export-dialog";
import { SavedViews } from "./saved-views";
import { EditColumnsModal } from "./edit-columns";
import { AllFiltersDrawer } from "./all-filters-drawer";
import { OfficeProfile } from "./office-profile";
import { DEFAULT_FILTERS, SALES_VOLUME_BUCKETS, COUNT_BUCKETS, YEAR_BUCKETS, GCI_BUCKETS, ieCount, rangeCount, officeSearchCount } from "@/types/agent-filters";
import type { Filters } from "@/types/agent-filters";
import { useNameSearch } from "@/lib/stores/name-search";

const PAGE_SIZES = [20, 50, 100];

// ---------- formatters ----------
function usdShort(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
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
// Sales volume, with a per-source breakdown when the agent is matched across sources.
function VolCell({ a }: { a: Agent }) {
  const stats = a.source_stats ?? [];
  return (
    <div>
      <div>{usd(a.sales_volume)}</div>
      {stats.length > 1 && (
        <div className="mt-0.5 space-y-0.5">
          {stats.map((s) => (
            <div key={s.source} className="text-[11px] capitalize text-neutral-400">
              {s.source}: {usd(s.sales_volume)}
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
  align?: "right";
  render: (a: Agent) => React.ReactNode;
}

// Courted default 28-column order.
const COLUMNS: Col[] = [
  { key: "agent", label: "Agent", sortBy: "full_name", render: (a) => <span className="font-semibold text-neutral-900">{na(a.full_name)}</span> },
  { key: "office", label: "Office", render: (a) => na(a.office_name) },
  { key: "timeInd", label: "Est. time in industry", sortBy: "est_time_in_industry_months", render: (a) => a.est_time_in_industry_raw ?? "N/A" },
  { key: "license", label: "License number", render: (a) => na(a.license_number) },
  { key: "mlsAff", label: "MLS affiliation", render: (a) => a.mls?.[0]?.code ?? "N/A" },
  { key: "mlsId", label: "MLS ID", render: (a) => a.mls?.[0]?.member_id ?? "N/A" },
  { key: "homeCity", label: "Home city", render: (a) => (a.home_city ? `${a.home_city}${a.home_state ? `, ${a.home_state}` : ""}` : "N/A") },
  { key: "homeZip", label: "Home zip", render: (a) => na(a.home_zip) },
  { key: "brand", label: "Brand", render: (a) => na(a.brand) },
  { key: "officeCity", label: "Office city", render: (a) => (a.office_city ? `${a.office_city}${a.office_state ? `, ${a.office_state}` : ""}` : "N/A") },
  { key: "officeZip", label: "Office zip code", render: (a) => na(a.office_zip) },
  { key: "timeOffice", label: "Est. time at office", render: (a) => ym(a.est_time_at_office_months) },
  { key: "avgTimeOffice", label: "Avg. time at office", render: (a) => ym(a.avg_time_at_office_months) },
  { key: "transacted", label: "Most transacted city", render: (a) => (a.most_transacted_city ? `${a.most_transacted_city}${a.transacted_state ? `, ${a.transacted_state}` : ""}` : "N/A") },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (a) => <VolCell a={a} /> },
  { key: "pct", label: "% Change", align: "right", render: (a) => <PctChange n={a.pct_change} /> },
  { key: "buy$", label: "Buy-side ($)", align: "right", render: (a) => usd(a.buy_side_dollar) },
  { key: "list$", label: "List-side ($)", align: "right", render: (a) => usd(a.list_side_dollar) },
  { key: "gci", label: "Approx. GCI", align: "right", render: (a) => usd(a.approx_gci) },
  { key: "avgPrice", label: "Avg. sales price", sortBy: "avg_sale_price", align: "right", render: (a) => usd(a.avg_sale_price) },
  { key: "closedTx", label: "Closed transactions", sortBy: "closed_transactions", align: "right", render: (a) => numv(a.closed_transactions) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (a) => numv(a.units) },
  { key: "buyN", label: "Buy-side (#)", align: "right", render: (a) => numv(a.buy_side_count) },
  { key: "listN", label: "List-side (#)", align: "right", render: (a) => numv(a.list_side_count) },
  { key: "rentals", label: "Closed rentals", align: "right", render: (a) => numv(a.closed_rentals) },
  { key: "avgRent", label: "Avg. rental price", align: "right", render: (a) => usd(a.avg_rental_price) },
  { key: "email", label: "Preferred email address", render: (a) => na(a.preferred_email) },
  { key: "phone", label: "Preferred phone number", render: (a) => phoneFmt(a.preferred_phone) },
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

  const activeFilterCount =
    filters.location.values.length +
    rangeCount(filters.salesVolume) +
    officeSearchCount(filters.officeSearch) +
    filters.mls.include.length +
    ieCount(filters.title) +
    ieCount(filters.license) +
    rangeCount(filters.closedUnits) +
    rangeCount(filters.closedTransactions) +
    rangeCount(filters.estTimeInIndustry) +
    rangeCount(filters.approxGci) +
    rangeCount(filters.avgSalePrice) +
    rangeCount(filters.estTimeInOffice) +
    rangeCount(filters.avgTimeAtOffice) +
    ieCount(filters.name);
  // The top-bar search is a find/highlight tool, not a filter — so it does not count here.

  function setF<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((p) => ({ ...p, [k]: v }));
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/search/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, source, sortBy, sortDir, page, pageSize, filters }),
      });
      const json: SearchResponse = await res.json();
      setRows(json.data ?? []);
      setTotal(json.totalCount ?? 0);
      setVol(json.salesVolumeTotal ?? 0);
    } finally {
      setLoading(false);
    }
  }, [mode, source, sortBy, sortDir, page, pageSize, filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function toggleSort(col: Col) {
    if (!col.sortBy) return;
    if (sortBy === col.sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col.sortBy);
      setSortDir("desc");
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
                  setMode(m);
                  setPage(1);
                  setSelected(new Set());
                }}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${mode === m ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {m === "agent" ? "Agent" : "Office"}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 text-sm">
            {([["all", "All"], ["courted", "Courted"], ["zillow_realtor", "Zillow / Realtor"]] as const).map(([s, lbl]) => (
              <button
                key={s}
                type="button"
                onClick={() => {
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
          <LocationPopover value={filters.location} onChange={(v) => setF("location", v)} />
          <RangePopover label="Sales volume" hasSide prefix="$" buckets={SALES_VOLUME_BUCKETS} value={filters.salesVolume} onChange={(v) => setF("salesVolume", v)} />
          <OfficeSearchPopover value={filters.officeSearch} onChange={(v) => setF("officeSearch", v)} />
          <MlsPopover value={filters.mls} onChange={(v) => setF("mls", v)} />
          <TitlePopover value={filters.title} onChange={(v) => setF("title", v)} />
          <LicensePopover value={filters.license} onChange={(v) => setF("license", v)} />
          <NamePopover value={filters.name} onChange={(v) => setF("name", v)} />
          <RangePopover label="Closed units" hasSide prefix="#" buckets={COUNT_BUCKETS} value={filters.closedUnits} onChange={(v) => setF("closedUnits", v)} />
          <RangePopover label="Closed transactions" hasSide prefix="#" buckets={COUNT_BUCKETS} value={filters.closedTransactions} onChange={(v) => setF("closedTransactions", v)} />
          <RangePopover label="Est. time in industry" suffix="yrs" buckets={YEAR_BUCKETS} value={{ side: "all", ...filters.estTimeInIndustry }} onChange={(v) => setF("estTimeInIndustry", { buckets: v.buckets, min: v.min, max: v.max })} />
          <RangePopover label="Approx. GCI" prefix="$" buckets={GCI_BUCKETS} value={{ side: "all", ...filters.approxGci }} onChange={(v) => setF("approxGci", { buckets: v.buckets, min: v.min, max: v.max })} />
          <button
            type="button"
            onClick={() => setAllFiltersOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <SlidersHorizontal className="h-4 w-4" />
            All filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-900 px-1.5 text-xs font-medium text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
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
            <button type="button" title="Export — Send to Clay" onClick={() => setExportOpen(true)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100">
              <Download className="h-[18px] w-[18px]" />
            </button>
            <SavedViews
              filters={filters}
              onLoad={(f) => {
                setFilters(f);
                setNameSearch(f.nameQuery ?? ""); // keep the top-bar search box in sync with the loaded view
                setPage(1);
              }}
            />
          </div>
        </div>

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto border-t border-neutral-200">
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
                      className={`whitespace-nowrap px-4 py-2.5 text-[13px] font-medium text-neutral-500 ${col.align === "right" ? "text-right" : "text-left"}`}
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
                            className={`whitespace-nowrap px-4 py-3 text-neutral-700 ${col.align === "right" ? "text-right tabular-nums" : "text-left"} ${cellHit ? "bg-green-200/70" : ""}`}
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
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex h-8 min-w-8 items-center justify-center rounded-md border border-neutral-200 px-2">{page}</span>
            <span className="text-neutral-500">out of {totalPages.toLocaleString()}</span>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
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
