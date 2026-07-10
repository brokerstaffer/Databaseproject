"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SideRadios, BucketPills, MinMax } from "./agent-filters";
import { useTypeahead, RadioOpt, Chips, SearchBox, LOCATION_FIELDS, LOCATION_KINDS } from "./agent-typeahead-filters";
import type {
  Bucket,
  Filters,
  IncludeExclude,
  LocationField,
  LocationFilter,
  LocationKind,
  OfficeSearchFilter,
  RangeF,
  RangeSide,
  VolumeSide,
} from "@/types/agent-filters";
import {
  DEFAULT_FILTERS,
  SALES_VOLUME_BUCKETS,
  COUNT_BUCKETS,
  YEAR_BUCKETS,
  GCI_BUCKETS,
  TITLES,
  ieCount,
  rangeCount,
  officeSearchCount,
} from "@/types/agent-filters";

type RangeLike = { side?: VolumeSide; buckets: string[]; min: string; max: string };

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-200 px-4 py-4">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
        {title}
        {count ? <span className="font-normal text-neutral-400">({count})</span> : null}
      </div>
      {children}
    </div>
  );
}

// ---------- sections ----------
function LocationSection({ value, onChange }: { value: LocationFilter; onChange: (v: LocationFilter) => void }) {
  const { query, setQuery, options } = useTypeahead("location", value.field);
  const label = LOCATION_FIELDS.find((f) => f[0] === value.field)?.[1] ?? "City";
  const toggleKind = (k: LocationKind) =>
    onChange({ ...value, appliesTo: value.appliesTo.includes(k) ? value.appliesTo.filter((x) => x !== k) : [...value.appliesTo, k] });
  return (
    <Section title="Location" count={value.values.length}>
      <div className="flex gap-2">
        <Select value={value.field} onValueChange={(v) => onChange({ ...value, field: v as LocationField, values: [] })}>
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
            options={options.filter((o) => !value.values.includes(o))}
            onPick={(v) => {
              if (!value.values.includes(v)) onChange({ ...value, values: [...value.values, v] });
              setQuery("");
            }}
          />
        </div>
      </div>
      <div className="mt-1 text-right text-xs text-neutral-400">{value.values.length}/50</div>
      <Chips items={value.values} onRemove={(v) => onChange({ ...value, values: value.values.filter((x) => x !== v) })} />
      <div className="mt-3 space-y-2.5">
        {LOCATION_KINDS.map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm text-neutral-800">
            <Checkbox checked={value.appliesTo.includes(k)} onCheckedChange={() => toggleKind(k)} />
            {l}
          </label>
        ))}
      </div>
    </Section>
  );
}

function RangeSection({
  title,
  count,
  value,
  onChange,
  buckets,
  hasSide,
  prefix,
  suffix,
}: {
  title: string;
  count?: number;
  value: RangeLike;
  onChange: (v: RangeLike) => void;
  buckets: Bucket[];
  hasSide?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const toggle = (k: string) =>
    onChange({ ...value, buckets: value.buckets.includes(k) ? value.buckets.filter((x) => x !== k) : [...value.buckets, k] });
  return (
    <Section title={title} count={count}>
      {hasSide && <SideRadios side={value.side ?? "all"} onChange={(s) => onChange({ ...value, side: s })} />}
      <BucketPills buckets={buckets} selected={value.buckets} onToggle={toggle} />
      <MinMax
        min={value.min}
        max={value.max}
        setMin={(v) => onChange({ ...value, min: v })}
        setMax={(v) => onChange({ ...value, max: v })}
        prefix={prefix}
        suffix={suffix}
      />
    </Section>
  );
}

function OfficeSearchSection({ value, onChange }: { value: OfficeSearchFilter; onChange: (v: OfficeSearchFilter) => void }) {
  const [entity, setEntity] = useState<"brand" | "office">("brand");
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const { query, setQuery, options } = useTypeahead(entity);
  const g = value[entity];
  const taken = [...g.include, ...g.exclude];
  const pick = (v: string) => {
    const next: IncludeExclude =
      mode === "include"
        ? { include: g.include.includes(v) ? g.include : [...g.include, v], exclude: g.exclude.filter((x) => x !== v) }
        : { exclude: g.exclude.includes(v) ? g.exclude : [...g.exclude, v], include: g.include.filter((x) => x !== v) };
    onChange(entity === "brand" ? { ...value, brand: next } : { ...value, office: next });
    setQuery("");
  };
  return (
    <Section title="Office Search" count={officeSearchCount(value)}>
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
      {(value.brand.include.length > 0 || value.brand.exclude.length > 0) && (
        <div className="mt-3">
          <div className="text-xs font-medium text-neutral-500">Brand</div>
          <Chips items={value.brand.include} onRemove={(v) => onChange({ ...value, brand: { ...value.brand, include: value.brand.include.filter((x) => x !== v) } })} />
          <Chips items={value.brand.exclude} tone="exclude" onRemove={(v) => onChange({ ...value, brand: { ...value.brand, exclude: value.brand.exclude.filter((x) => x !== v) } })} />
        </div>
      )}
      {(value.office.include.length > 0 || value.office.exclude.length > 0) && (
        <div className="mt-3">
          <div className="text-xs font-medium text-neutral-500">Office</div>
          <Chips items={value.office.include} onRemove={(v) => onChange({ ...value, office: { ...value.office, include: value.office.include.filter((x) => x !== v) } })} />
          <Chips items={value.office.exclude} tone="exclude" onRemove={(v) => onChange({ ...value, office: { ...value.office, exclude: value.office.exclude.filter((x) => x !== v) } })} />
        </div>
      )}
    </Section>
  );
}

interface MlsItem {
  id: string;
  code: string | null;
  name: string | null;
}
function MlsSection({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MlsItem[]>([]);
  const [clients, setClients] = useState<string[]>([]);
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
      if (value.include.length === 0) {
        setClients([]);
        return;
      }
      try {
        const res = await fetch("/api/mls/clients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mlsIds: value.include }),
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
  }, [value.include]);
  const toggle = (id: string) =>
    onChange({ include: value.include.includes(id) ? value.include.filter((x) => x !== id) : [...value.include, id], exclude: [] });
  return (
    <Section title="MLS" count={value.include.length}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search MLS"
          className="h-10 w-full rounded-lg border border-neutral-300 pl-9 pr-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      </div>
      <div className="mt-2 max-h-48 space-y-0.5 overflow-auto">
        {items.length === 0 ? (
          <div className="px-1 py-2 text-sm text-neutral-400">No MLS found.</div>
        ) : (
          items.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50">
              <Checkbox checked={value.include.includes(m.id)} onCheckedChange={() => toggle(m.id)} />
              <span className="truncate">
                {m.name ?? m.code}
                {m.code && m.name && m.name !== m.code && <span className="text-neutral-400"> ({m.code})</span>}
              </span>
            </label>
          ))
        )}
      </div>
      {clients.length > 0 && (
        <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">Current clients using this MLS: {clients.join(", ")}</div>
      )}
    </Section>
  );
}

function TitleSection({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const toggleInc = (t: string) =>
    onChange({ include: value.include.includes(t) ? value.include.filter((x) => x !== t) : [...value.include, t], exclude: value.exclude.filter((x) => x !== t) });
  const toggleExc = (t: string) =>
    onChange({ exclude: value.exclude.includes(t) ? value.exclude.filter((x) => x !== t) : [...value.exclude, t], include: value.include.filter((x) => x !== t) });
  return (
    <Section title="Title" count={ieCount(value)}>
      <div className="mb-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-6 text-xs font-medium text-neutral-500">
        <span />
        <span>Include</span>
        <span>Exclude</span>
      </div>
      <div className="space-y-2">
        {TITLES.map((t) => (
          <div key={t} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6">
            <span className="text-sm text-neutral-800">{t}</span>
            <div className="flex w-12 justify-center">
              <Checkbox checked={value.include.includes(t)} onCheckedChange={() => toggleInc(t)} aria-label={`Include ${t}`} />
            </div>
            <div className="flex w-12 justify-center">
              <Checkbox checked={value.exclude.includes(t)} onCheckedChange={() => toggleExc(t)} aria-label={`Exclude ${t}`} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function NameSection({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const { query, setQuery, options } = useTypeahead("name");
  const taken = [...value.include, ...value.exclude];
  const pick = (v: string) => {
    onChange(
      mode === "include"
        ? { include: value.include.includes(v) ? value.include : [...value.include, v], exclude: value.exclude.filter((x) => x !== v) }
        : { exclude: value.exclude.includes(v) ? value.exclude : [...value.exclude, v], include: value.include.filter((x) => x !== v) }
    );
    setQuery("");
  };
  return (
    <Section title="Name" count={ieCount(value)}>
      <div className="flex items-center gap-6">
        <RadioOpt
          label="Include"
          on={mode === "include"}
          onClick={() => {
            setMode("include");
            onChange({ include: Array.from(new Set([...value.include, ...value.exclude])), exclude: [] });
          }}
        />
        <RadioOpt
          label="Exclude"
          on={mode === "exclude"}
          onClick={() => {
            setMode("exclude");
            onChange({ include: [], exclude: Array.from(new Set([...value.exclude, ...value.include])) });
          }}
        />
      </div>
      <div className="mt-2">
        <SearchBox placeholder="Search by name" query={query} setQuery={setQuery} options={options.filter((o) => !taken.includes(o))} onPick={pick} />
      </div>
      <Chips items={value.include} onRemove={(v) => onChange({ ...value, include: value.include.filter((x) => x !== v) })} />
      <Chips items={value.exclude} tone="exclude" onRemove={(v) => onChange({ ...value, exclude: value.exclude.filter((x) => x !== v) })} />
    </Section>
  );
}

function LicenseSection({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const { query, setQuery, options } = useTypeahead("license");
  const taken = [...value.include, ...value.exclude];
  const pick = (v: string) => {
    onChange(
      mode === "include"
        ? { include: value.include.includes(v) ? value.include : [...value.include, v], exclude: value.exclude.filter((x) => x !== v) }
        : { exclude: value.exclude.includes(v) ? value.exclude : [...value.exclude, v], include: value.include.filter((x) => x !== v) }
    );
    setQuery("");
  };
  return (
    <Section title="License" count={ieCount(value)}>
      <div className="flex items-center gap-6">
        <RadioOpt
          label="Include"
          on={mode === "include"}
          onClick={() => {
            setMode("include");
            onChange({ include: Array.from(new Set([...value.include, ...value.exclude])), exclude: [] });
          }}
        />
        <RadioOpt
          label="Exclude"
          on={mode === "exclude"}
          onClick={() => {
            setMode("exclude");
            onChange({ include: [], exclude: Array.from(new Set([...value.exclude, ...value.include])) });
          }}
        />
      </div>
      <div className="mt-2">
        <SearchBox placeholder="Search license #" query={query} setQuery={setQuery} options={options.filter((o) => !taken.includes(o))} onPick={pick} />
      </div>
      <Chips items={value.include} onRemove={(v) => onChange({ ...value, include: value.include.filter((x) => x !== v) })} />
      <Chips items={value.exclude} tone="exclude" onRemove={(v) => onChange({ ...value, exclude: value.exclude.filter((x) => x !== v) })} />
    </Section>
  );
}

// ---------- the drawer ----------
export function AllFiltersDrawer({
  open,
  onOpenChange,
  filters,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: Filters;
  onApply: (f: Filters) => void;
}) {
  const [draft, setDraft] = useState<Filters>(filters);
  useEffect(() => {
    if (open) setDraft(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof Filters>(k: K, v: Filters[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-neutral-200">
          <SheetTitle>All filters</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <LocationSection value={draft.location} onChange={(v) => set("location", v)} />
          <RangeSection title="Sales volume" count={rangeCount(draft.salesVolume)} value={draft.salesVolume} onChange={(v) => set("salesVolume", v as RangeSide)} buckets={SALES_VOLUME_BUCKETS} hasSide prefix="$" />
          <OfficeSearchSection value={draft.officeSearch} onChange={(v) => set("officeSearch", v)} />
          <MlsSection value={draft.mls} onChange={(v) => set("mls", v)} />
          <NameSection value={draft.name} onChange={(v) => set("name", v)} />
          <TitleSection value={draft.title} onChange={(v) => set("title", v)} />
          <LicenseSection value={draft.license} onChange={(v) => set("license", v)} />
          <RangeSection title="Closed units" count={rangeCount(draft.closedUnits)} value={draft.closedUnits} onChange={(v) => set("closedUnits", v as RangeSide)} buckets={COUNT_BUCKETS} hasSide />
          <RangeSection title="Closed transactions" count={rangeCount(draft.closedTransactions)} value={draft.closedTransactions} onChange={(v) => set("closedTransactions", v as RangeSide)} buckets={COUNT_BUCKETS} hasSide />
          <RangeSection title="Est. time in industry" count={rangeCount(draft.estTimeInIndustry)} value={draft.estTimeInIndustry} onChange={(v) => set("estTimeInIndustry", v as RangeF)} buckets={YEAR_BUCKETS} suffix="yrs" />
          <RangeSection title="Approx GCI" count={rangeCount(draft.approxGci)} value={draft.approxGci} onChange={(v) => set("approxGci", v as RangeF)} buckets={GCI_BUCKETS} prefix="$" />
          <RangeSection title="Average sales price" count={rangeCount(draft.avgSalePrice)} value={draft.avgSalePrice} onChange={(v) => set("avgSalePrice", v as RangeF)} buckets={[]} prefix="$" />
          <RangeSection title="Est. time in office" count={rangeCount(draft.estTimeInOffice)} value={draft.estTimeInOffice} onChange={(v) => set("estTimeInOffice", v as RangeF)} buckets={YEAR_BUCKETS} suffix="yrs" />
          <RangeSection title="Average time at office" count={rangeCount(draft.avgTimeAtOffice)} value={draft.avgTimeAtOffice} onChange={(v) => set("avgTimeAtOffice", v as RangeF)} buckets={YEAR_BUCKETS} suffix="yrs" />
        </div>
        <SheetFooter className="flex-row items-center justify-between border-t border-neutral-200">
          <button type="button" onClick={() => setDraft(DEFAULT_FILTERS)} className="text-sm font-medium text-neutral-700 hover:text-neutral-900">
            Clear all
          </button>
          <Button onClick={() => { onApply(draft); onOpenChange(false); }}>Show results</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
