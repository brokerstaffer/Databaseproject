"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { Agent, SearchResponse, SortDir } from "@/types/agent";
import { RangePopover, TitlePopover } from "./agent-filters";
import { LocationPopover, OfficeSearchPopover, MlsPopover } from "./agent-typeahead-filters";
import { ExportDialog } from "./export-dialog";
import { SavedViews } from "./saved-views";
import { EditColumnsModal } from "./edit-columns";
import { DEFAULT_FILTERS, SALES_VOLUME_BUCKETS, COUNT_BUCKETS, YEAR_BUCKETS, GCI_BUCKETS } from "@/types/agent-filters";
import type { Filters } from "@/types/agent-filters";

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
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (a) => usd(a.sales_volume) },
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

export function AgentSearch() {
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

  function setF<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((p) => ({ ...p, [k]: v }));
    setPage(1);
  }

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/search/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "agent", source: "courted", sortBy, sortDir, page, pageSize, filters }),
      });
      const json: SearchResponse = await res.json();
      setRows(json.data ?? []);
      setTotal(json.totalCount ?? 0);
      setVol(json.salesVolumeTotal ?? 0);
    } finally {
      setLoading(false);
    }
  }, [sortBy, sortDir, page, pageSize, filters]);

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
        <h1 className="shrink-0 text-2xl font-bold tracking-tight text-neutral-900">Agent Search</h1>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <LocationPopover value={filters.location} onChange={(v) => setF("location", v)} />
          <RangePopover label="Sales volume" hasSide prefix="$" buckets={SALES_VOLUME_BUCKETS} value={filters.salesVolume} onChange={(v) => setF("salesVolume", v)} />
          <OfficeSearchPopover value={filters.officeSearch} onChange={(v) => setF("officeSearch", v)} />
          <MlsPopover value={filters.mls} onChange={(v) => setF("mls", v)} />
          <TitlePopover value={filters.title} onChange={(v) => setF("title", v)} />
          <RangePopover label="Closed units" hasSide prefix="#" buckets={COUNT_BUCKETS} value={filters.closedUnits} onChange={(v) => setF("closedUnits", v)} />
          <RangePopover label="Closed transactions" hasSide prefix="#" buckets={COUNT_BUCKETS} value={filters.closedTransactions} onChange={(v) => setF("closedTransactions", v)} />
          <RangePopover label="Est. time in industry" suffix="yrs" buckets={YEAR_BUCKETS} value={{ side: "all", ...filters.estTimeInIndustry }} onChange={(v) => setF("estTimeInIndustry", { buckets: v.buckets, min: v.min, max: v.max })} />
          <RangePopover label="Approx. GCI" prefix="$" buckets={GCI_BUCKETS} value={{ side: "all", ...filters.approxGci }} onChange={(v) => setF("approxGci", { buckets: v.buckets, min: v.min, max: v.max })} />
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <SlidersHorizontal className="h-4 w-4" />
            All filters
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
                <span className="text-neutral-500"> Agents found</span>
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
                {visibleColumns.map((col) => {
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
                  <td colSpan={visibleColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    No agents found.
                  </td>
                </tr>
              ) : (
                rows.map((a) => (
                  <tr key={a.id} className="border-b border-neutral-100 hover:bg-neutral-50">
                    <td className="w-10 px-4 py-3">
                      <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleOne(a.id)} aria-label="Select row" />
                    </td>
                    {visibleColumns.map((col) => (
                      <td
                        key={col.key}
                        className={`whitespace-nowrap px-4 py-3 text-neutral-700 ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                      >
                        {col.render(a)}
                      </td>
                    ))}
                  </tr>
                ))
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

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} filters={filters} total={total} selectedIds={Array.from(selected)} />
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
    </div>
  );
}
