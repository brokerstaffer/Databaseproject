"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FilterPopoverShell } from "./agent-filters";
import type { IncludeExclude, LocationField, LocationFilter, LocationKind, OfficeSearchFilter } from "@/types/agent-filters";

// ---------- helpers ----------
function useTypeahead(type: string, field?: string) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ type, q: query });
      if (field) p.set("field", field);
      try {
        const res = await fetch(`/api/search/options?${p.toString()}`);
        const json = await res.json();
        if (active) setOptions(Array.isArray(json.options) ? (json.options as string[]) : []);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [type, field, query]);
  return { query, setQuery, options };
}

function RadioOpt({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 text-sm text-neutral-800">
      <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", on ? "border-neutral-900" : "border-neutral-300")}>
        {on && <span className="h-2 w-2 rounded-full bg-neutral-900" />}
      </span>
      {label}
    </button>
  );
}

function Chips({ items, onRemove, tone = "default" }: { items: string[]; onRemove: (v: string) => void; tone?: "default" | "exclude" }) {
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

function SearchBox({
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
const LOCATION_FIELDS: [LocationField, string][] = [
  ["city", "City"],
  ["zip", "Zip code"],
  ["county", "County"],
  ["state", "State"],
];
const LOCATION_KINDS: [LocationKind, string][] = [
  ["office", "Office location"],
  ["transacted", "Most transacted location"],
  ["home", "Home location"],
];

export function LocationPopover({ value, onChange }: { value: LocationFilter; onChange: (v: LocationFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<LocationField>(value.field);
  const [kinds, setKinds] = useState<LocationKind[]>(value.appliesTo);
  const [values, setValues] = useState<string[]>(value.values);
  const { query, setQuery, options } = useTypeahead("location", field);

  useEffect(() => {
    if (open) {
      setField(value.field);
      setKinds(value.appliesTo);
      setValues(value.values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = LOCATION_FIELDS.find((f) => f[0] === field)?.[1] ?? "City";
  const toggleKind = (k: LocationKind) => setKinds((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  return (
    <FilterPopoverShell
      label="Location"
      count={value.values.length}
      open={open}
      onOpenChange={setOpen}
      width="w-[460px]"
      onClear={() => {
        setField("city");
        setKinds(["office", "home", "transacted"]);
        setValues([]);
        setQuery("");
      }}
      onApply={() => {
        onChange({ field, appliesTo: kinds, values });
        setOpen(false);
      }}
    >
      <div className="flex gap-2">
        <Select
          value={field}
          onValueChange={(v) => {
            setField(v as LocationField);
            setValues([]);
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
          <SearchBox
            placeholder={`Search by ${label.toLowerCase()}`}
            query={query}
            setQuery={setQuery}
            options={options.filter((o) => !values.includes(o))}
            onPick={(v) => {
              if (!values.includes(v)) setValues([...values, v]);
              setQuery("");
            }}
          />
        </div>
      </div>
      <div className="mt-1 text-right text-xs text-neutral-400">{values.length}/50</div>
      <Chips items={values} onRemove={(v) => setValues(values.filter((x) => x !== v))} />
      <div className="mt-3 space-y-2.5">
        {LOCATION_KINDS.map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm text-neutral-800">
            <Checkbox checked={kinds.includes(k)} onCheckedChange={() => toggleKind(k)} />
            {l}
          </label>
        ))}
      </div>
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
  const { query, setQuery, options } = useTypeahead(entity);

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
  const taken = entity === "brand" ? [...bInc, ...bExc] : [...oInc, ...oExc];

  const pick = (v: string) => {
    if (entity === "brand") {
      if (mode === "include") {
        setBInc((a) => (a.includes(v) ? a : [...a, v]));
        setBExc((a) => a.filter((x) => x !== v));
      } else {
        setBExc((a) => (a.includes(v) ? a : [...a, v]));
        setBInc((a) => a.filter((x) => x !== v));
      }
    } else if (mode === "include") {
      setOInc((a) => (a.includes(v) ? a : [...a, v]));
      setOExc((a) => a.filter((x) => x !== v));
    } else {
      setOExc((a) => (a.includes(v) ? a : [...a, v]));
      setOInc((a) => a.filter((x) => x !== v));
    }
    setQuery("");
  };

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
        <RadioOpt label="Include" on={mode === "include"} onClick={() => setMode("include")} />
        <RadioOpt label="Exclude" on={mode === "exclude"} onClick={() => setMode("exclude")} />
      </div>
      <div className="mt-2">
        <SearchBox placeholder={`Search ${entity}`} query={query} setQuery={setQuery} options={options.filter((o) => !taken.includes(o))} onPick={pick} />
      </div>
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

export function MlsPopover({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MlsItem[]>([]);
  const [sel, setSel] = useState<string[]>(value.include);
  const [clients, setClients] = useState<string[]>([]);

  useEffect(() => {
    if (open) setSel(value.include);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    let active = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/options?type=mls&q=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (active) setItems(Array.isArray(json.options) ? (json.options as MlsItem[]) : []);
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
      count={value.include.length}
      open={open}
      onOpenChange={setOpen}
      width="w-[420px]"
      onClear={() => setSel([])}
      onApply={() => {
        onChange({ include: sel, exclude: [] });
        setOpen(false);
      }}
    >
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search MLS"
          className="h-10 w-full rounded-lg border border-neutral-300 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      </div>
      <div className="mt-2 max-h-56 space-y-0.5 overflow-auto">
        {items.length === 0 ? (
          <div className="px-1 py-2 text-sm text-neutral-400">No MLS found.</div>
        ) : (
          items.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
              <Checkbox checked={sel.includes(m.id)} onCheckedChange={() => toggle(m.id)} />
              {m.name ?? m.code}
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
