"use client";

import { useEffect, useState } from "react";
import { Save, Trash2, FolderOpen } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";

interface SavedList {
  id: string;
  name: string;
  filters: Filters;
}

export function SavedViews({ filters, onLoad }: { filters: Filters; onLoad: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<SavedList[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const r = await fetch("/api/lists");
    const j = await r.json();
    setLists(j.lists ?? []);
  }
  useEffect(() => {
    if (open) load();
  }, [open]);

  async function save() {
    if (!name.trim()) {
      toast.error("Name this view");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("View saved");
      setName("");
      load();
    } else {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Save failed");
    }
  }

  async function del(id: string) {
    const res = await fetch(`/api/lists/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function update(id: string) {
    const res = await fetch(`/api/lists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters }),
    });
    if (res.ok) {
      toast.success("View updated with current filters");
      load();
    } else {
      toast.error("Update failed");
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title="Save / load views" className="rounded-md bg-neutral-100 p-2 text-neutral-500 hover:bg-neutral-200">
          <Save className="h-[18px] w-[18px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-3 shadow-xl">
        <div className="text-sm font-medium text-neutral-800">Save current filters</div>
        <div className="mt-2 flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this view…"
            className="h-9"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <Button onClick={save} disabled={saving} size="sm" className="h-9">
            Save
          </Button>
        </div>
        <div className="mb-1 mt-3 text-xs font-medium text-neutral-500">Saved views</div>
        <div className="max-h-56 space-y-0.5 overflow-auto">
          {lists.length === 0 ? (
            <div className="px-1 py-2 text-sm text-neutral-400">No saved views yet.</div>
          ) : (
            lists.map((v) => (
              <div key={v.id} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-neutral-50">
                <button
                  type="button"
                  onClick={() => {
                    onLoad(v.filters);
                    setOpen(false);
                    toast.success(`Loaded "${v.name}"`);
                  }}
                  className="flex items-center gap-2 text-left text-sm text-neutral-800"
                >
                  <FolderOpen className="h-4 w-4 text-neutral-400" />
                  {v.name}
                </button>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => update(v.id)} title="Save current filters into this view" className="text-xs font-medium text-neutral-500 hover:text-neutral-900">
                    Update
                  </button>
                  <button type="button" onClick={() => del(v.id)} className="text-neutral-300 hover:text-red-600" title="Delete view">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
