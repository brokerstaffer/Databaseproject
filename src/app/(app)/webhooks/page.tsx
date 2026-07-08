"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface OrchClientRow {
  id: string;
  client_name: string | null;
  status: string | null;
  mls: string | null;
  location: string | null;
  bison_campaign_id: string | null;
  leads_inreview: boolean;
  bison_leads_exported: boolean;
  lead_count: number;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  leads_built: "bg-green-100 text-green-800",
  onboarding: "bg-blue-100 text-blue-800",
  pending: "bg-neutral-100 text-neutral-700",
};

// Clients page (route kept at /webhooks) — a READ-ONLY view of orch_clients, the shared
// table the orchestrator and other apps maintain. Clients appear here automatically when
// onboarded; their campaigns are matched by name ("Client Name + Sender + Market") and
// sends go through the in-house enrichment pipeline.
export default function ClientsPage() {
  const [clients, setClients] = useState<OrchClientRow[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/orch/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
    setSyncedAt(j.campaignsSyncedAt ?? null);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

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

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Clients</h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            Managed by the onboarding system — new clients appear here automatically. Campaigns match by name
            (“Client Name + Sender + Market”); sends enrich each agent, skip leads already in the client’s campaigns, then upload to
            EmailBison.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {syncedAt && <span className="text-xs text-neutral-400">Campaigns synced {new Date(syncedAt).toLocaleString()}</span>}
          <Button variant="outline" onClick={syncCampaigns} disabled={syncing} className="gap-1.5">
            {syncing ? "Syncing…" : "Sync campaigns"}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">MLS</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3 text-right">Leads built</th>
              <th className="px-4 py-3">In review</th>
              <th className="px-4 py-3">Exported</th>
              <th className="px-4 py-3 text-right">Campaign ID</th>
              <th className="px-4 py-3">Onboarded</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-neutral-400">
                  Loading…
                </td>
              </tr>
            ) : clients.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-neutral-400">
                  No clients yet — they appear here automatically once onboarded.
                </td>
              </tr>
            ) : (
              clients.map((c) => (
                <tr key={c.id} className="border-b border-neutral-100">
                  <td className="px-4 py-3 font-medium text-neutral-900">{c.client_name ?? "Unnamed client"}</td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_TONE[c.status ?? ""] ?? "bg-neutral-100 text-neutral-700"}>{c.status ?? "—"}</Badge>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{c.mls ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">{c.location ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-800">{c.lead_count.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {c.leads_inreview ? <Badge className="bg-amber-100 text-amber-800">In review</Badge> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {c.bison_leads_exported ? <Badge className="bg-green-100 text-green-800">Exported</Badge> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-600">{c.bison_campaign_id ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-500">{new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
