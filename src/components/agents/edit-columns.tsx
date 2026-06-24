"use client";

import { useEffect, useState } from "react";
import { GripVertical, Lock, Search } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ColMeta {
  key: string;
  label: string;
}

export function EditColumnsModal({
  open,
  onOpenChange,
  columns,
  locked,
  order,
  hidden,
  defaultOrder,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  columns: ColMeta[];
  locked: string[];
  order: string[];
  hidden: string[];
  defaultOrder: string[];
  onSave: (order: string[], hidden: string[]) => void;
}) {
  const [ord, setOrd] = useState<string[]>(order);
  const [hid, setHid] = useState<Set<string>>(new Set(hidden));
  const [q, setQ] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setOrd(order);
      setHid(new Set(hidden));
      setQ("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));
  const isLocked = (k: string) => locked.includes(k);
  const visible = ord.filter((k) => !hid.has(k));

  const toggle = (k: string) => {
    if (isLocked(k)) return;
    setHid((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  function onDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey || isLocked(targetKey) || isLocked(dragKey)) {
      setDragKey(null);
      return;
    }
    setOrd((prev) => {
      const arr = [...prev];
      const from = arr.indexOf(dragKey);
      const to = arr.indexOf(targetKey);
      if (from < 0 || to < 0) return prev;
      arr.splice(from, 1);
      arr.splice(to, 0, dragKey);
      return arr;
    });
    setDragKey(null);
  }

  const avail = columns.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit columns</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-sm text-neutral-500">Choose which columns to show and drag to set their order. Agent and Office are locked.</p>
        <div className="grid grid-cols-2 gap-4">
          {/* Available */}
          <div>
            <div className="mb-2 text-sm font-medium text-neutral-700">{columns.length} columns</div>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search columns"
                className="h-9 w-full rounded-lg border border-neutral-300 pl-8 pr-2 text-sm focus:outline-none"
              />
            </div>
            <div className="max-h-72 space-y-0.5 overflow-auto">
              {avail.map((c) => (
                <label key={c.key} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm">
                  <Checkbox checked={!hid.has(c.key)} disabled={isLocked(c.key)} onCheckedChange={() => toggle(c.key)} />
                  <span className={isLocked(c.key) ? "text-neutral-400" : "text-neutral-800"}>{c.label}</span>
                </label>
              ))}
            </div>
          </div>
          {/* Selected (ordered) */}
          <div>
            <div className="mb-2 text-sm font-medium text-neutral-700">{visible.length} selected</div>
            <div className="max-h-[19.5rem] space-y-1 overflow-auto rounded-lg border border-neutral-200 p-2">
              {visible.map((k) => (
                <div
                  key={k}
                  draggable={!isLocked(k)}
                  onDragStart={() => setDragKey(k)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(k)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    isLocked(k) ? "border-neutral-100 bg-neutral-50 text-neutral-500" : "cursor-grab border-neutral-200 bg-white text-neutral-800",
                    dragKey === k && "opacity-50"
                  )}
                >
                  {isLocked(k) ? <Lock className="h-3.5 w-3.5 text-neutral-400" /> : <GripVertical className="h-4 w-4 text-neutral-400" />}
                  {byKey[k]?.label}
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              setOrd(defaultOrder);
              setHid(new Set());
            }}
          >
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onSave(ord, [...hid]);
                onOpenChange(false);
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
