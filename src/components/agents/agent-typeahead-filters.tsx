"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FilterPopoverShell } from "./agent-filters";
import type { IncludeExclude, LocationField, LocationFilter, LocationKind, OfficeSearchFilter } from "@/types/agent-filters";

// ---------- helpers ----------
export function useTypeahead(type: string, field?: string) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [total, setTotal] = useState(0); // count of the unfiltered list = "total available"
  useEffect(() => {
    let active = true;
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ type, q: query });
      if (field) p.set("field", field);
      try {
        const res = await fetch(`/api/search/options?${p.toString()}`);
        const json = await res.json();
        if (active) {
          const raw = Array.isArray(json.options) ? (json.options as (string | { v: string })[]) : [];
          const opts = raw.map((o) => (typeof o === "string" ? o : o.v));
          setOptions(opts);
          if (!query.trim()) setTotal(opts.length);
        }
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [type, field, query]);
  return { query, setQuery, options, total };
}

export interface LocOpt {
  v: string;   // display + filter value ("Miami, FL")
  n: number;   // agents (or offices in office scope) matching
  var: number; // how many raw spelling variants collapse into this option
}
// Location options: precomputed, agent-count ordered, with live match totals (C2).
export function useLocationOptions(field: string, scope: "agent" | "office") {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<LocOpt[]>([]);
  const [total, setTotal] = useState(0);   // matching option groups
  const [agents, setAgents] = useState(0); // agents (offices) covered by those groups
  useEffect(() => {
    let active = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/options?type=location&field=${field}&scope=${scope}&q=${encodeURIComponent(query)}`);
        const json = await res.json();
        if (active) {
          setOptions(Array.isArray(json.options) ? (json.options as LocOpt[]) : []);
          setTotal(json.total ?? 0);
          setAgents(json.agents ?? 0);
        }
      } catch {
        /* ignore */
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [field, scope, query]);
  return { query, setQuery, options, total, agents };
}

// Plain search input (no dropdown) — pairs with the always-visible CheckList below it.
function SearchInput({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-neutral-300 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
      />
    </div>
  );
}

// The options API caps lists at this many rows — when a list hits it, the true universe is
// unknown, so counters and "Select all" must not pretend the shown slice is everything.
const OPTIONS_CAP = 50;

// "X out of Y selected" + [Select all · Clear], shown above every CheckList. When the list is
// capped, the denominator is dropped (we only know what's shown, not the true total).
function CountRow({ selected, total, capped = false, onSelectAll, onClear }: { selected: number; total: number; capped?: boolean; onSelectAll: () => void; onClear: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-between px-1 text-xs">
      <span className="text-neutral-400">{capped ? `${selected} selected` : `${selected} out of ${total} selected`}</span>
      <div className="flex gap-3">
        <button type="button" className="text-neutral-600 hover:underline" onClick={onSelectAll}>
          Select all
        </button>
        <button type="button" className="text-neutral-600 hover:underline" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

// Always-visible checkbox list ("Select all" lives in the CountRow header above, next to
// Clear). Options appear immediately when the filter opens.
function CheckList({
  options,
  isSelected,
  onToggle,
  emptyText = "No results.",
}: {
  options: string[];
  isSelected: (o: string) => boolean;
  onToggle: (o: string) => void;
  emptyText?: string;
}) {
  return (
    <>
      <div className="mt-1 max-h-56 space-y-0.5 overflow-auto">
        {options.length === 0 ? (
          <div className="px-1 py-2 text-sm text-neutral-400">{emptyText}</div>
        ) : (
          options.map((o) => (
            <label key={o} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
              <Checkbox checked={isSelected(o)} onCheckedChange={() => onToggle(o)} />
              <span className="truncate">{o}</span>
            </label>
          ))
        )}
      </div>
      {options.length >= OPTIONS_CAP && (
        <p className="mt-1 px-1 text-[11px] text-neutral-400">Showing the first {OPTIONS_CAP} matches — type to narrow.</p>
      )}
    </>
  );
}

export function RadioOpt({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 text-sm text-neutral-800">
      <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", on ? "border-neutral-900" : "border-neutral-300")}>
        {on && <span className="h-2 w-2 rounded-full bg-neutral-900" />}
      </span>
      {label}
    </button>
  );
}

export function Chips({ items, onRemove, tone = "default" }: { items: string[]; onRemove: (v: string) => void; tone?: "default" | "exclude" }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((v) => (
        <span
          key={v}
          className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs", tone === "exclude" ? "bg-red-50 text-red-700" : "bg-brand/10 text-brand")}
        >
          {v}
          <button type="button" onClick={() => onRemove(v)}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function SearchBox({
  placeholder,
  query,
  setQuery,
  options,
  onPick,
}: {
  placeholder: string;
  query: string;
  setQuery: (v: string) => void;
  options: string[];
  onPick: (v: string) => void;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-neutral-400" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => {
          // Enter adds whatever is typed, even without picking a suggestion.
          if (e.key === "Enter" && query.trim()) {
            e.preventDefault();
            onPick(query.trim());
          }
        }}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-neutral-300 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
      />
      {focus && query.length > 0 && options.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o);
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-50"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Location ----------
export const LOCATION_FIELDS: [LocationField, string][] = [
  ["city", "City"],
  ["zip", "Zip code"],
  ["county", "County"],
  ["state", "State"],
];
export const LOCATION_KINDS: [LocationKind, string][] = [
  ["office", "Office location"],
  ["transacted", "Most transacted location"],
  ["home", "Home location"],
];

export function LocationPopover({ value, onChange, officeMode = false }: { value: LocationFilter; onChange: (v: LocationFilter) => void; officeMode?: boolean }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<LocationField>(value.field);
  const [kinds, setKinds] = useState<LocationKind[]>(value.appliesTo);
  const [values, setValues] = useState<string[]>(value.values);
  const [excluded, setExcluded] = useState<string[]>(value.excludeValues);
  const [bucket, setBucket] = useState<"include" | "exclude">("include");
  // Precomputed options: instant, ordered by agent count, "City, ST" display with variant
  // counts and live totals (C2). Office view sees office locations only (A8).
  const { query, setQuery, options, total, agents } = useLocationOptions(field, officeMode ? "office" : "agent");

  useEffect(() => {
    if (open) {
      setField(value.field);
      setKinds(value.appliesTo);
      setValues(value.values);
      setExcluded(value.excludeValues);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = LOCATION_FIELDS.find((f) => f[0] === field)?.[1] ?? "City";
  const toggleKind = (k: LocationKind) => setKinds((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  // Hard 50-value cap across BOTH buckets — the same rule the All-filters drawer enforces.
  const LOCATION_CAP = 50;
  // Mode-only radio (A14): steers which bucket NEW picks land in; existing chips never move.
  const cur = bucket === "include" ? values : excluded;
  const setCur = bucket === "include" ? setValues : setExcluded;
  const setOther = bucket === "include" ? setExcluded : setValues;
  const toggleValue = (v: string) => {
    if (cur.includes(v)) setCur((vs) => vs.filter((x) => x !== v));
    else if (values.length + excluded.length < LOCATION_CAP) {
      setCur((vs) => [...vs, v]);
      setOther((vs) => vs.filter((x) => x !== v));
    }
  };
  const selectAllShown = () =>
    setCur((vs) => {
      const merged = [...vs];
      const otherLen = (bucket === "include" ? excluded : values).length;
      for (const o of options) {
        if (merged.length + otherLen >= LOCATION_CAP) break;
        const bare = o.v.replace(/,\s*[A-Za-z]{2}$/, "");
        if (!merged.includes(o.v) && !merged.includes(bare)) merged.push(o.v);
      }
      return merged;
    });

  const unit = officeMode ? "offices" : "agents";
  return (
    <FilterPopoverShell
      label="Location"
      count={value.values.length + value.excludeValues.length}
      open={open}
      onOpenChange={setOpen}
      width="w-[460px]"
      onClear={() => {
        setField("city");
        setKinds(["office", "home", "transacted"]);
        setValues([]);
        setExcluded([]);
        setQuery("");
        onChange({ field: "city", appliesTo: ["office", "home", "transacted"], values: [], excludeValues: [] }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ field, appliesTo: kinds, values, excludeValues: excluded });
        setOpen(false);
      }}
    >
      <div className="mb-2 flex items-center gap-6">
        {/* Mode-only radios (A14): steer NEW picks; existing chips keep their bucket. */}
        <RadioOpt label="Include" on={bucket === "include"} onClick={() => setBucket("include")} />
        <RadioOpt label="Exclude" on={bucket === "exclude"} onClick={() => setBucket("exclude")} />
      </div>
      <div className="flex gap-2">
        <Select
          value={field}
          onValueChange={(v) => {
            setField(v as LocationField);
            setValues([]);
            setExcluded([]);
            setQuery("");
          }}
        >
          <SelectTrigger className="h-10 w-32 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCATION_FIELDS.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1">
          <SearchInput placeholder={`Search by ${label.toLowerCase()}`} value={query} onChange={setQuery} />
        </div>
      </div>
      {/* live totals while typing (C2): matching option groups + covered agents */}
      <div className="mt-2 flex items-center justify-between px-1 text-xs">
        <span className="text-neutral-400">
          {total.toLocaleString()} {total === 1 ? "match" : "matches"} · ≈{agents.toLocaleString()} {unit}
          <span className="ml-2 text-neutral-300">|</span>
          <span className="ml-2">{values.length + excluded.length} selected</span>
        </span>
        <div className="flex gap-3">
          <button type="button" className="text-neutral-600 hover:underline" onClick={selectAllShown}>
            Select all
          </button>
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              setValues([]);
              setExcluded([]);
              onChange({ field, appliesTo: kinds, values: [], excludeValues: [] }); // Clear applies immediately (A4)
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="mt-1 max-h-56 space-y-0.5 overflow-auto">
        {options.length === 0 ? (
          <div className="px-1 py-2 text-sm text-neutral-400">No results.</div>
        ) : (
          options.map((o) => {
            // a legacy saved view may hold the bare form ("Towson") of this composite option
            const bare = o.v.replace(/,\s*[A-Za-z]{2}$/, "");
            const checked = cur.includes(o.v) || cur.includes(bare);
            return (
            <label key={o.v} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
              <Checkbox
                checked={checked}
                onCheckedChange={() =>
                  checked ? setCur((vs) => vs.filter((x) => x !== o.v && x !== bare)) : toggleValue(o.v)
                }
              />
              <span className="min-w-0 flex-1 truncate">{o.v}</span>
              <span className="shrink-0 text-xs text-neutral-400">
                {o.n.toLocaleString()} {unit}
                {field === "city" && o.var > 1 ? ` · ${o.var} variants` : ""}
              </span>
            </label>
            );
          })
        )}
      </div>
      <Chips items={values} onRemove={(v) => setValues(values.filter((x) => x !== v))} />
      <Chips items={excluded} tone="exclude" onRemove={(v) => setExcluded(excluded.filter((x) => x !== v))} />
      {values.length + excluded.length >= LOCATION_CAP && (
        <p className="mt-1 px-1 text-[11px] text-amber-600">{LOCATION_CAP} locations max — remove some to add more.</p>
      )}
      {/* Office mode always filters on the OFFICE's location — the kind checkboxes only apply
          to agent searches, so they're hidden there instead of silently ignored. */}
      {!officeMode && (
        <div className="mt-3 space-y-2.5">
          {LOCATION_KINDS.map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-sm text-neutral-800">
              <Checkbox checked={kinds.includes(k)} onCheckedChange={() => toggleKind(k)} />
              {l}
            </label>
          ))}
        </div>
      )}
    </FilterPopoverShell>
  );
}

// ---------- Office Search (Brand + Office, grouped include/exclude) ----------
export function OfficeSearchPopover({ value, onChange }: { value: OfficeSearchFilter; onChange: (v: OfficeSearchFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [entity, setEntity] = useState<"brand" | "office">("brand");
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [bInc, setBInc] = useState<string[]>(value.brand.include);
  const [bExc, setBExc] = useState<string[]>(value.brand.exclude);
  const [oInc, setOInc] = useState<string[]>(value.office.include);
  const [oExc, setOExc] = useState<string[]>(value.office.exclude);
  const { query, setQuery, options, total } = useTypeahead(entity);

  useEffect(() => {
    if (open) {
      setBInc(value.brand.include);
      setBExc(value.brand.exclude);
      setOInc(value.office.include);
      setOExc(value.office.exclude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.brand.include.length + value.brand.exclude.length + value.office.include.length + value.office.exclude.length;
  const cur = entity === "brand" ? (mode === "include" ? bInc : bExc) : (mode === "include" ? oInc : oExc);
  const other = entity === "brand" ? (mode === "include" ? bExc : bInc) : (mode === "include" ? oExc : oInc);
  const setCur = entity === "brand" ? (mode === "include" ? setBInc : setBExc) : (mode === "include" ? setOInc : setOExc);
  const setOther = entity === "brand" ? (mode === "include" ? setBExc : setBInc) : (mode === "include" ? setOExc : setOInc);
  const totalSelected = bInc.length + bExc.length + oInc.length + oExc.length;
  const toggleOne = (o: string) => {
    if (cur.includes(o)) setCur((a) => a.filter((x) => x !== o));
    else { setCur((a) => [...a, o]); setOther((a) => a.filter((x) => x !== o)); }
  };
  // Bulk select only ADDS options that aren't in either bucket — it must never silently move
  // a chip out of the opposite bucket (a single explicit click via toggleOne may).
  const selectAll = () => setCur((a) => Array.from(new Set([...a, ...options.filter((o) => !other.includes(o))])));

  return (
    <FilterPopoverShell
      label="Office Search"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-[460px]"
      onClear={() => {
        setBInc([]);
        setBExc([]);
        setOInc([]);
        setOExc([]);
        setQuery("");
        onChange({ brand: { include: [], exclude: [] }, office: { include: [], exclude: [] } }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ brand: { include: bInc, exclude: bExc }, office: { include: oInc, exclude: oExc } });
        setOpen(false);
      }}
    >
      <div className="flex items-center gap-4">
        <Select
          value={entity}
          onValueChange={(v) => {
            setEntity(v as "brand" | "office");
            setQuery("");
          }}
        >
          <SelectTrigger className="h-10 w-28 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="brand">Brand</SelectItem>
            <SelectItem value="office">Office</SelectItem>
          </SelectContent>
        </Select>
        {/* Mode-only radios: they steer which bucket NEW picks land in. Existing chips keep
            their bucket (remove them individually or Clear) — flipping the radio must never
            silently move chips, that inverts the applied filter (the Loom bug). */}
        <RadioOpt label="Include" on={mode === "include"} onClick={() => setMode("include")} />
        <RadioOpt label="Exclude" on={mode === "exclude"} onClick={() => setMode("exclude")} />
      </div>
      <div className="mt-2">
        <SearchInput placeholder={`Search ${entity}`} value={query} onChange={setQuery} />
      </div>
      <CountRow selected={totalSelected} total={Math.max(total, totalSelected)} capped={total >= OPTIONS_CAP} onSelectAll={selectAll} onClear={() => { setBInc([]); setBExc([]); setOInc([]); setOExc([]); onChange({ brand: { include: [], exclude: [] }, office: { include: [], exclude: [] } }); }} />
      <CheckList options={options} isSelected={(o) => cur.includes(o)} onToggle={toggleOne} />
      {(bInc.length > 0 || bExc.length > 0) && (
        <div className="mt-3">
          <div className="text-xs font-medium text-neutral-500">Brand</div>
          <Chips items={bInc} onRemove={(v) => setBInc(bInc.filter((x) => x !== v))} />
          <Chips items={bExc} tone="exclude" onRemove={(v) => setBExc(bExc.filter((x) => x !== v))} />
        </div>
      )}
      {(oInc.length > 0 || oExc.length > 0) && (
        <div className="mt-3">
          <div className="text-xs font-medium text-neutral-500">Office</div>
          <Chips items={oInc} onRemove={(v) => setOInc(oInc.filter((x) => x !== v))} />
          <Chips items={oExc} tone="exclude" onRemove={(v) => setOExc(oExc.filter((x) => x !== v))} />
        </div>
      )}
    </FilterPopoverShell>
  );
}

// ---------- MLS (searchable list + "clients using this MLS" banner) ----------
interface MlsItem {
  id: string;
  code: string | null;
  name: string | null;
}

export function MlsPopover({
  value,
  multiMls,
  onChange,
}: {
  value: IncludeExclude;
  multiMls: boolean;
  onChange: (v: IncludeExclude, multiMls: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MlsItem[]>([]);
  const [sel, setSel] = useState<string[]>(value.include);
  const [multi, setMulti] = useState(multiMls);
  const [clients, setClients] = useState<string[]>([]);
  const [total, setTotal] = useState(0); // total MLS available (from the unfiltered list)

  useEffect(() => {
    if (open) {
      setSel(value.include);
      setMulti(multiMls);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    let active = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/options?type=mls&q=${encodeURIComponent(q)}`);
        const json = await res.json();
        const opts = Array.isArray(json.options) ? (json.options as MlsItem[]) : [];
        if (active) {
          setItems(opts);
          if (q.trim() === "") setTotal(opts.length); // unfiltered list = the total MLS count
        }
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (sel.length === 0) {
        setClients([]);
        return;
      }
      try {
        const res = await fetch("/api/mls/clients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mlsIds: sel }),
        });
        const json = await res.json();
        if (active) setClients(Array.isArray(json.clients) ? (json.clients as string[]) : []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [sel]);

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <FilterPopoverShell
      label="MLS"
      count={value.include.length + (multiMls ? 1 : 0)}
      open={open}
      onOpenChange={setOpen}
      width="w-[420px]"
      onClear={() => {
        setSel([]);
        setMulti(false);
        onChange({ include: [], exclude: [] }, false); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ include: sel, exclude: [] }, multi);
        setOpen(false);
      }}
    >
      {/* A5: isolate agents affiliated with more than one MLS */}
      <label className="mb-2 flex items-center gap-2 text-sm text-neutral-800">
        <Checkbox checked={multi} onCheckedChange={() => setMulti(!multi)} />
        Only agents in multiple MLSs
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search MLS"
          className="h-10 w-full rounded-lg border border-neutral-300 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      </div>
      {/* The mls options list is NOT capped (unlike the typeaheads) — the full MLS table is
          always shown, so the denominator is always honest here. */}
      <div className="mt-2 flex items-center justify-between px-1 text-xs">
        <span className="text-neutral-400">{sel.length} out of {Math.max(total, sel.length)} selected</span>
        <div className="flex gap-3">
          <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSel((s) => Array.from(new Set([...s, ...items.map((m) => m.id)])))}>
            Select all
          </button>
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              setSel([]);
              onChange({ include: [], exclude: [] }, multiMls); // header Clear drops codes only — commits the APPLIED multiMls, never the draft
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="mt-1 max-h-56 space-y-0.5 overflow-auto">
        {items.length === 0 ? (
          <div className="px-1 py-2 text-sm text-neutral-400">No MLS found.</div>
        ) : (
          items.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
              <Checkbox checked={sel.includes(m.id)} onCheckedChange={() => toggle(m.id)} />
              <span className="truncate">
                {m.name ?? m.code}
                {m.code && m.name && m.name !== m.code && <span className="text-neutral-400"> ({m.code})</span>}
              </span>
            </label>
          ))
        )}
      </div>
      {clients.length > 0 && (
        <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Current clients using this MLS: {clients.join(", ")}
        </div>
      )}
    </FilterPopoverShell>
  );
}

// ---------- License (typeahead include/exclude on license number) ----------
export function LicensePopover({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [inc, setInc] = useState<string[]>(value.include);
  const [exc, setExc] = useState<string[]>(value.exclude);
  const { query, setQuery, options, total } = useTypeahead("license");

  useEffect(() => {
    if (open) {
      setInc(value.include);
      setExc(value.exclude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.include.length + value.exclude.length;
  const cur = mode === "include" ? inc : exc;
  const other = mode === "include" ? exc : inc;
  const setCur = mode === "include" ? setInc : setExc;
  const setOther = mode === "include" ? setExc : setInc;
  const toggleOne = (o: string) => {
    if (cur.includes(o)) setCur((a) => a.filter((x) => x !== o));
    else { setCur((a) => [...a, o]); setOther((a) => a.filter((x) => x !== o)); }
  };
  // Bulk select only ADDS options not in either bucket — never silently moves a chip.
  const selectAll = () => setCur((a) => Array.from(new Set([...a, ...options.filter((o) => !other.includes(o))])));

  return (
    <FilterPopoverShell
      label="License"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-[420px]"
      onClear={() => {
        setInc([]);
        setExc([]);
        setQuery("");
        onChange({ include: [], exclude: [] }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ include: inc, exclude: exc });
        setOpen(false);
      }}
    >
      <div className="flex items-center gap-6">
        {/* Mode-only radios: steer NEW picks; existing chips keep their bucket (Loom bug). */}
        <RadioOpt label="Include" on={mode === "include"} onClick={() => setMode("include")} />
        <RadioOpt label="Exclude" on={mode === "exclude"} onClick={() => setMode("exclude")} />
      </div>
      <div className="mt-2">
        <SearchInput placeholder="Search license #" value={query} onChange={setQuery} />
      </div>
      <CountRow selected={inc.length + exc.length} total={Math.max(total, inc.length + exc.length)} capped={total >= OPTIONS_CAP} onSelectAll={selectAll} onClear={() => { setInc([]); setExc([]); onChange({ include: [], exclude: [] }); }} />
      <CheckList options={options} isSelected={(o) => cur.includes(o)} onToggle={toggleOne} />
      <Chips items={inc} onRemove={(v) => setInc(inc.filter((x) => x !== v))} />
      <Chips items={exc} tone="exclude" onRemove={(v) => setExc(exc.filter((x) => x !== v))} />
    </FilterPopoverShell>
  );
}

// ---------- Name (typeahead include/exclude on full name) ----------
export function NamePopover({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [inc, setInc] = useState<string[]>(value.include);
  const [exc, setExc] = useState<string[]>(value.exclude);
  const { query, setQuery, options, total } = useTypeahead("name");

  useEffect(() => {
    if (open) {
      setInc(value.include);
      setExc(value.exclude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.include.length + value.exclude.length;
  const cur = mode === "include" ? inc : exc;
  const other = mode === "include" ? exc : inc;
  const setCur = mode === "include" ? setInc : setExc;
  const setOther = mode === "include" ? setExc : setInc;
  const toggleOne = (o: string) => {
    if (cur.includes(o)) setCur((a) => a.filter((x) => x !== o));
    else { setCur((a) => [...a, o]); setOther((a) => a.filter((x) => x !== o)); }
  };
  // Bulk select only ADDS options not in either bucket — never silently moves a chip.
  const selectAll = () => setCur((a) => Array.from(new Set([...a, ...options.filter((o) => !other.includes(o))])));

  return (
    <FilterPopoverShell
      label="Name"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-[420px]"
      onClear={() => {
        setInc([]);
        setExc([]);
        setQuery("");
        onChange({ include: [], exclude: [] }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ include: inc, exclude: exc });
        setOpen(false);
      }}
    >
      <div className="flex items-center gap-6">
        {/* Mode-only radios: steer NEW picks; existing chips keep their bucket (Loom bug). */}
        <RadioOpt label="Include" on={mode === "include"} onClick={() => setMode("include")} />
        <RadioOpt label="Exclude" on={mode === "exclude"} onClick={() => setMode("exclude")} />
      </div>
      <div className="mt-2">
        <SearchInput placeholder="Search by name" value={query} onChange={setQuery} />
      </div>
      <CountRow selected={inc.length + exc.length} total={Math.max(total, inc.length + exc.length)} capped={total >= OPTIONS_CAP} onSelectAll={selectAll} onClear={() => { setInc([]); setExc([]); onChange({ include: [], exclude: [] }); }} />
      <CheckList options={options} isSelected={(o) => cur.includes(o)} onToggle={toggleOne} />
      <Chips items={inc} onRemove={(v) => setInc(inc.filter((x) => x !== v))} />
      <Chips items={exc} tone="exclude" onRemove={(v) => setExc(exc.filter((x) => x !== v))} />
    </FilterPopoverShell>
  );
}
