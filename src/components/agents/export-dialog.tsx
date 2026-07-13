"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";
import type { DataSource, SearchMode } from "@/types/agent";
import { EXPORT_COLUMNS } from "@/lib/export/columns";

interface ClientOpt {
  id: string;
  client_name: string | null;
  status: string | null;
  lead_count: number;
  bison_campaign_id: string | null;
  has_portal: boolean;
}
interface PortalClientOpt {
  name: string;
  enabled: boolean;
}
interface Campaign {
  id: string;
  bison_campaign_id: string;
  bison_id: string; // EmailBison's numeric campaign id
  name: string | null;
  status: string | null;
}

const ALL_KEYS = EXPORT_COLUMNS.map((c) => c.key);

export function ExportDialog({
  open,
  onOpenChange,
  filters,
  total,
  selectedIds,
  source,
  mode = "agent",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: Filters;
  total: number;
  selectedIds: string[];
  source: DataSource;
  mode?: SearchMode;
}) {
  const [method, setMethod] = useState<"campaign" | "csv" | "portal">("campaign");
  const [sourcePriority, setSourcePriority] = useState<"courted" | "zillow" | "realtor">("courted");
  const [portalTarget, setPortalTarget] = useState<"agents" | "dnc">("agents");
  const [portalClients, setPortalClients] = useState<PortalClientOpt[]>([]);
  const [portalClient, setPortalClient] = useState("");
  const [portalErr, setPortalErr] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [clientId, setClientId] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cols, setCols] = useState<Set<string>>(new Set(ALL_KEYS));
  const [busy, setBusy] = useState(false);

  // Clients come from orch_clients — the shared table other apps (the orchestrator) maintain.
  useEffect(() => {
    if (open) {
      fetch("/api/orch/clients")
        .then((r) => r.json())
        .then((j) => setClients(j.clients ?? []));
    }
  }, [open]);

  // Portal clients come from the portal's own admin directory (names only — tokens stay
  // server-side); fetched lazily the first time the portal method is picked.
  useEffect(() => {
    if (open && method === "portal" && portalClients.length === 0) {
      setPortalErr(null);
      fetch("/api/portal/clients")
        .then((r) => r.json())
        .then((j) => {
          if (j.error) setPortalErr(j.error);
          else setPortalClients(j.clients ?? []);
        })
        .catch(() => setPortalErr("Could not reach the client portal"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method]);

  useEffect(() => {
    if (clientId) {
      const target = clients.find((c) => c.id === clientId)?.bison_campaign_id ?? null;
      fetch(`/api/bison/campaigns?orchClientId=${clientId}`)
        .then((r) => r.json())
        .then((j) => {
          const list: Campaign[] = j.campaigns ?? [];
          setCampaigns(list);
          // the client's designated campaign (orch_clients.bison_campaign_id) is the default
          setCampaignId(list.find((c) => c.bison_id === target)?.id ?? "");
        });
    } else {
      setCampaigns([]);
      setCampaignId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // In Office mode the export is "all agents belonging to the chosen offices".
  const office = mode === "office";
  const hasSel = selectedIds.length > 0;
  const scope = hasSel
    ? office
      ? `all agents in ${selectedIds.length} selected office${selectedIds.length > 1 ? "s" : ""}`
      : `${selectedIds.length} selected agents`
    : from || to
    ? office
      ? `all agents in offices ranked ${from || 1}–${to || total}`
      : `agents ${from || 1}–${to || total}`
    : office
    ? `all agents in the ${total.toLocaleString()} matching offices`
    : `all ${total.toLocaleString()} agents`;

  const reqBody = () => ({
    mode,
    source,
    filters,
    selectedIds: selectedIds.length ? selectedIds : undefined,
    rangeFrom: from || undefined,
    rangeTo: to || undefined,
  });
  const toggleCol = (k: string) =>
    setCols((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  // Send to campaign: queues the agents as an enrichment batch. The enrich-worker finds and
  // verifies an email for each (cached results reused), skips leads already in one of this
  // client's campaigns, and pushes the rest into the chosen EmailBison campaign.
  async function sendCampaign() {
    if (!clientId) {
      toast.error("Select a client");
      return;
    }
    const campaign = campaigns.find((c) => c.id === campaignId);
    if (!campaign) {
      toast.error("Select a campaign");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/enrichment/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...reqBody(), orchClientId: clientId, campaignId: campaign.bison_id, campaignName: campaign.name ?? null, sourcePriority }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(`Queued ${j.queued} agents — enriching now, then into “${campaign.name}”. Track progress in Admin → Activity.`, { duration: 8000 });
      onOpenChange(false);
    } else {
      toast.error(j.error ?? "Send failed");
    }
  }

  // Client portal: writes the agents into the client's portal — "Your Agents" roster or the
  // DNC list. Both are idempotent on the portal side and also blocklist the emails on the
  // sending tools so these people can never be cold-emailed for that client.
  async function sendPortal() {
    if (!portalClient) {
      toast.error("Select a client");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/portal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...reqBody(), portalClient, target: portalTarget }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(
        `Added ${j.inserted} agents to ${j.client}'s ${portalTarget === "agents" ? "Your Agents" : "DNC list"}${j.alreadyThere ? ` — ${j.alreadyThere} were already there` : ""}.`,
        { duration: 8000 }
      );
      onOpenChange(false);
    } else {
      toast.error(j.error ?? "Portal send failed");
    }
  }

  async function downloadCsv() {
    if (cols.size === 0) {
      toast.error("Select at least one column");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/export/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reqBody(), columns: [...cols] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "CSV export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "broker-staffer-agents.csv";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export agents</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* method */}
          <div>
            <label className="text-sm font-medium text-neutral-700">Method</label>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {([["campaign", "Send to campaign"], ["csv", "Download CSV"], ["portal", "Client portal"]] as const).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    method === m ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* campaign options */}
          {method === "campaign" && (
            <>
              <div>
                <label className="text-sm font-medium text-neutral-700">Client</label>
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select a client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.client_name ?? "Unnamed client"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {clients.length === 0 && <p className="mt-1 text-xs text-neutral-500">No clients yet — they appear here once onboarded (orch_clients).</p>}
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-700">EmailBison campaign</label>
                <Select value={campaignId} onValueChange={setCampaignId} disabled={!clientId || campaigns.length === 0}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={campaigns.length ? "Select a campaign" : "No campaigns synced yet"} />
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name ?? c.bison_campaign_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-700">Data priority</label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {([["courted", "Courted"], ["zillow", "Zillow"], ["realtor", "Realtor"]] as const).map(([s, lbl]) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSourcePriority(s)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                        sourcePriority === s ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Which source’s values win for the lead fields — blanks fall back to the next source
                  ({sourcePriority === "courted" ? "Courted → Zillow → Realtor" : sourcePriority === "zillow" ? "Zillow → Courted → Realtor" : "Realtor → Courted → Zillow"}).
                </p>
              </div>
              <p className="text-xs text-neutral-500">
                Each agent is enriched (email found + verified), leads already in this client’s campaigns are skipped, and the rest are
                uploaded into the campaign with all custom variables.
              </p>
            </>
          )}

          {/* portal options */}
          {method === "portal" && (
            <>
              <div>
                <label className="text-sm font-medium text-neutral-700">Client</label>
                <Select value={portalClient} onValueChange={setPortalClient}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={portalClients.length ? "Select a client" : "Loading portals…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {portalClients.map((c) => (
                      <SelectItem key={c.name} value={c.name} disabled={!c.enabled}>
                        {c.name}
                        {!c.enabled && " (portal disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {portalErr && <p className="mt-1 text-xs text-red-600">{portalErr}</p>}
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-700">Add to</label>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {([["agents", "Your Agents"], ["dnc", "DNC list"]] as const).map(([t, lbl]) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPortalTarget(t)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                        portalTarget === t ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                {portalTarget === "agents"
                  ? "Adds the agents (name, email, phone, license) to the client's portal roster. Their emails are also blocklisted on the sending tools so the client's own agents are never cold-emailed."
                  : "Adds the agents to the client's Do-Not-Contact list. Entries with an email are blocklisted on Instantly and EmailBison immediately."}
                {" "}Re-sending the same agents is safe — the portal skips duplicates.
              </p>
            </>
          )}

          {/* columns — CSV only; campaign sends build their own variables */}
          {method === "csv" && (
            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-neutral-700">
                  Columns <span className="font-normal text-neutral-400">({cols.size}/{ALL_KEYS.length})</span>
                </label>
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-neutral-600 hover:underline" onClick={() => setCols(new Set(ALL_KEYS))}>
                    Select all
                  </button>
                  <button type="button" className="text-neutral-600 hover:underline" onClick={() => setCols(new Set())}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="mt-1.5 grid max-h-48 grid-cols-2 gap-x-4 gap-y-1.5 overflow-auto rounded-lg border border-neutral-200 p-3">
                {EXPORT_COLUMNS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm text-neutral-800">
                    <Checkbox checked={cols.has(c.key)} onCheckedChange={() => toggleCol(c.key)} />
                    <span className="truncate">{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* range */}
          <div>
            <label className="text-sm font-medium text-neutral-700">
              Range{" "}
              <span className="font-normal text-neutral-400">{hasSel ? "(ignored — rows are selected)" : "(blank = all filtered)"}</span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" inputMode="numeric" disabled={hasSel} />
              <span className="text-neutral-400">–</span>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" inputMode="numeric" disabled={hasSel} />
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            {method === "csv" ? "Exporting" : "Sending"}: <span className="font-medium text-neutral-700">{scope}</span>
            {method === "csv" ? ` · ${cols.size} columns` : ""}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {method === "campaign" ? (
            <Button onClick={sendCampaign} disabled={busy || !clientId || !campaignId}>
              {busy ? "Queueing…" : "Send to campaign"}
            </Button>
          ) : method === "portal" ? (
            <Button onClick={sendPortal} disabled={busy || !portalClient}>
              {busy ? "Sending…" : portalTarget === "agents" ? "Add to Your Agents" : "Add to DNC list"}
            </Button>
          ) : (
            <Button onClick={downloadCsv} disabled={busy}>
              {busy ? "Preparing…" : "Download CSV"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
