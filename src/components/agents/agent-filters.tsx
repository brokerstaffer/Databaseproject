"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { Bucket, IncludeExclude, VolumeSide } from "@/types/agent-filters";
import { TITLES } from "@/types/agent-filters";

const SIDES: [VolumeSide, string][] = [
  ["all", "All"],
  ["list", "List-side"],
  ["buy", "Buy-side"],
];

// ---------- shared popover chrome (Courted-style trigger + panel + Clear/Apply) ----------
export function FilterPopoverShell({
  label,
  count,
  open,
  onOpenChange,
  onClear,
  onApply,
  width = "w-[420px]",
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onClear: () => void;
  onApply: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
            count > 0 ? "bg-neutral-200 text-neutral-900" : "text-neutral-700 hover:bg-neutral-200"
          )}
        >
          {label}
          {count > 0 ? <span className="text-neutral-500">{` (${count})`}</span> : null}
          <ChevronDown className="ml-0.5 h-4 w-4 text-neutral-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className={cn("rounded-2xl border-neutral-200 p-4 shadow-xl", width)}>
        {children}
        <div className="mt-4 flex items-center justify-end gap-4">
          <button type="button" onClick={onClear} className="text-sm font-medium text-neutral-700 hover:text-neutral-900">
            Clear
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-lg bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SideRadios({ side, onChange }: { side: VolumeSide; onChange: (s: VolumeSide) => void }) {
  return (
    <div className="mb-3 flex items-center gap-6">
      {SIDES.map(([val, lbl]) => (
        <button key={val} type="button" onClick={() => onChange(val)} className="flex items-center gap-2 text-sm text-neutral-800">
          <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", side === val ? "border-neutral-900" : "border-neutral-300")}>
            {side === val && <span className="h-2 w-2 rounded-full bg-neutral-900" />}
          </span>
          {lbl}
        </button>
      ))}
    </div>
  );
}

function BucketPills({ buckets, selected, onToggle }: { buckets: Bucket[]; selected: string[]; onToggle: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {buckets.map((b) => {
        const on = selected.includes(b.key);
        return (
          <button
            key={b.key}
            type="button"
            onClick={() => onToggle(b.key)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
              on ? "border-brand bg-brand/5 text-brand" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
            )}
          >
            {b.label}
          </button>
        );
      })}
    </div>
  );
}

function MinMax({
  min,
  max,
  setMin,
  setMax,
  prefix,
  suffix,
}: {
  min: string;
  max: string;
  setMin: (v: string) => void;
  setMax: (v: string) => void;
  prefix?: string;
  suffix?: string;
}) {
  const field = (val: string, set: (v: string) => void, ph: string) => (
    <div className="relative flex-1">
      {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">{prefix}</span>}
      <input
        value={val}
        onChange={(e) => set(e.target.value)}
        inputMode="numeric"
        placeholder={ph}
        className={cn(
          "h-10 w-full rounded-lg border border-neutral-300 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none",
          prefix ? "pl-7" : "pl-3",
          suffix ? "pr-10" : "pr-3"
        )}
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">{suffix}</span>}
    </div>
  );
  return (
    <div className="mt-4 flex items-center gap-3">
      {field(min, setMin, "Min")}
      <span className="text-neutral-400">-</span>
      {field(max, setMax, "Max")}
    </div>
  );
}

// ---------- Range filter (Sales volume, Closed units/transactions [hasSide], Est. time, GCI) ----------
export interface RangeValue {
  side: VolumeSide;
  buckets: string[];
  min: string;
  max: string;
}

export function RangePopover({
  label,
  value,
  onChange,
  buckets,
  hasSide = false,
  prefix,
  suffix,
}: {
  label: string;
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  buckets: Bucket[];
  hasSide?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<VolumeSide>(value.side);
  const [sel, setSel] = useState<string[]>(value.buckets);
  const [min, setMin] = useState(value.min);
  const [max, setMax] = useState(value.max);

  useEffect(() => {
    if (open) {
      setSide(value.side);
      setSel(value.buckets);
      setMin(value.min);
      setMax(value.max);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.buckets.length + (value.min ? 1 : 0) + (value.max ? 1 : 0);
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  return (
    <FilterPopoverShell
      label={label}
      count={count}
      open={open}
      onOpenChange={setOpen}
      onClear={() => {
        setSide("all");
        setSel([]);
        setMin("");
        setMax("");
      }}
      onApply={() => {
        onChange({ side, buckets: sel, min, max });
        setOpen(false);
      }}
    >
      {hasSide && <SideRadios side={side} onChange={setSide} />}
      <BucketPills buckets={buckets} selected={sel} onToggle={toggle} />
      <MinMax min={min} max={max} setMin={setMin} setMax={setMax} prefix={prefix} suffix={suffix} />
    </FilterPopoverShell>
  );
}

// ---------- Title (include/exclude over the 3 fixed roles) ----------
export function TitlePopover({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [open, setOpen] = useState(false);
  const [inc, setInc] = useState<string[]>(value.include);
  const [exc, setExc] = useState<string[]>(value.exclude);

  useEffect(() => {
    if (open) {
      setInc(value.include);
      setExc(value.exclude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.include.length + value.exclude.length;
  const toggleInc = (t: string) => {
    setInc((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
    setExc((a) => a.filter((x) => x !== t));
  };
  const toggleExc = (t: string) => {
    setExc((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
    setInc((a) => a.filter((x) => x !== t));
  };

  return (
    <FilterPopoverShell
      label="Title"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-80"
      onClear={() => {
        setInc([]);
        setExc([]);
      }}
      onApply={() => {
        onChange({ include: inc, exclude: exc });
        setOpen(false);
      }}
    >
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
              <Checkbox checked={inc.includes(t)} onCheckedChange={() => toggleInc(t)} aria-label={`Include ${t}`} />
            </div>
            <div className="flex w-12 justify-center">
              <Checkbox checked={exc.includes(t)} onCheckedChange={() => toggleExc(t)} aria-label={`Exclude ${t}`} />
            </div>
          </div>
        ))}
      </div>
    </FilterPopoverShell>
  );
}
