"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

interface ClientRow {
  id: string;
  name: string;
  clay_webhook_url: string | null;
  bison_key_set: boolean;
  bison_synced_at: string | null;
}

export default function WebhooksPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [name, setName] = useState("");
  const [hook, setHook] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function syncCampaigns() {
    setSyncing(true);
    const res = await fetch("/api/cron/bison-sync", { method: "POST" });
    setSyncing(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(j.error ?? "Sync failed");
      return;
    }
    if (j.error) {
      toast.error(`Sync failed — ${j.error}`, { duration: 9000 });
    } else {
      toast.success(`Synced ${j.campaigns ?? 0} campaigns from the workspace`);
    }
    load();
  }

  async function load() {
    setLoading(true);
    const r = await fetch("/api/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setEditing(null);
    setName("");
    setHook("");
    setKey("");
    setOpen(true);
  }
  function openEdit(c: ClientRow) {
    setEditing(c);
    setName(c.name);
    setHook(c.clay_webhook_url ?? "");
    setKey("");
    setOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Client name is required");
      return;
    }
    setSaving(true);
    const payload = { name, clay_webhook_url: hook, bison_api_key: key };
    const res = editing
      ? await fetch(`/api/clients/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await fetch("/api/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Save failed");
      return;
    }
    toast.success(editing ? "Client updated" : "Client added");
    setOpen(false);
    load();
  }

  async function del(c: ClientRow) {
    if (!confirm(`Delete ${c.name}?`)) return;
    const res = await fetch(`/api/clients/${c.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Deleted");
      load();
    } else {
      toast.error("Delete failed");
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Webhooks</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={syncCampaigns} disabled={syncing} className="gap-1.5">
            {syncing ? "Syncing…" : "Sync campaigns"}
          </Button>
          <Button onClick={openNew} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Add client
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Clay webhook</th>
              <th className="px-4 py-3">Bison key</th>
              <th className="px-4 py-3">Last synced</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-neutral-400">
                  Loading…
                </td>
              </tr>
            ) : clients.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-neutral-400">
                  No clients yet. Add one to start sending lists to Clay.
                </td>
              </tr>
            ) : (
              clients.map((c) => (
                <tr key={c.id} className="border-b border-neutral-100">
                  <td className="px-4 py-3 font-medium text-neutral-900">{c.name}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-neutral-600">{c.clay_webhook_url ?? <span className="text-neutral-400">—</span>}</td>
                  <td className="px-4 py-3">{c.bison_key_set ? <span className="text-emerald-600">Set</span> : <span className="text-neutral-400">Not set</span>}</td>
                  <td className="px-4 py-3 text-neutral-600">{c.bison_synced_at ? new Date(c.bison_synced_at).toLocaleString() : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(c)} className="mr-3 text-neutral-500 hover:text-neutral-900">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => del(c)} className="text-neutral-500 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit client" : "Add client"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-neutral-700">Client name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Properties RE" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-neutral-700">Clay webhook URL</label>
              <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://api.clay.com/…/webhook" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-neutral-700">EmailBison API key</label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                type="password"
                placeholder={editing ? "Leave blank to keep current" : "Bison API key"}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
