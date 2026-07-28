"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// Admin > MLS: rename an MLS's abbreviation (code) or full name. Old codes are kept as
// hidden aliases so scraper imports and searches keep resolving.
interface MlsRow {
  id: string;
  code: string;
  name: string | null;
  aliases: string[];
  member_agents: number | null;
  refreshed: string | null;
}

export function MlsTab() {
  const [rows, setRows] = useState<MlsRow[] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    fetch("/api/admin/mls")
      .then((r) => r.json())
      .then((j) => setRows(j.mls ?? []))
      .catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (saving || !editId) return;
    setSaving(true);
    const res = await fetch("/api/admin/mls", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editId, code, name }),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast.error(j.error ?? "Failed to save");
      return;
    }
    toast.success("MLS updated");
    setEditId(null);
    load();
  }

  return (
    <div>
      <p className="mb-3 text-xs text-neutral-500">
        Renaming an abbreviation is safe: the old one is kept as a hidden alias, so scraper imports and
        searches keep matching, and agents&apos; primary-MLS labels follow the rename.
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs font-medium text-neutral-500">
          <tr className="border-b border-neutral-200">
            <th className="py-2 pr-3">Abbreviation</th>
            <th className="py-2 pr-3">Full name</th>
            <th className="py-2 pr-3 text-right">Agents</th>
            <th className="py-2 pr-3">Data refreshed</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            <tr><td colSpan={5} className="py-8 text-center text-neutral-400">Loading…</td></tr>
          ) : (
            rows.map((m) =>
              editId === m.id ? (
                <tr key={m.id} className="border-b border-neutral-100 bg-blue-50/40">
                  <td className="py-2 pr-3"><Input value={code} onChange={(e) => setCode(e.target.value)} className="h-8 w-32" /></td>
                  <td className="py-2 pr-3"><Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" /></td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">{m.member_agents?.toLocaleString() ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-2">
                      <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="outline" onClick={() => setEditId(null)} disabled={saving}>Cancel</Button>
                    </div>
                  </td>
                  <td />
                </tr>
              ) : (
                <tr key={m.id} className="border-b border-neutral-100">
                  <td className="py-2 pr-3 font-medium text-neutral-900">
                    {m.code}
                    {m.aliases?.length > 0 && (
                      <span className="ml-1.5 text-[11px] text-neutral-400" title="Former abbreviations (still matched)">
                        was {m.aliases.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-neutral-600">{m.name ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">{m.member_agents?.toLocaleString() ?? "—"}</td>
                  <td className="py-2 pr-3 text-neutral-500">{m.refreshed ?? "—"}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      title="Edit"
                      className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
                      onClick={() => {
                        setEditId(m.id);
                        setCode(m.code);
                        setName(m.name ?? "");
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              )
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
