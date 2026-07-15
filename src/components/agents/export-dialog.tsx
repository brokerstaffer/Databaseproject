"use client";

import { useEffect, useRef, useState } from "react";
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

interface PortalClientOpt {
  name: string;
  enabled: boolean;
}
interface Campaign {
  id: string; // bison_campaigns.id (internal UUID key — unique per campaign)
  bison_campaign_id: string;
  bison_id: string; // EmailBison's numeric campaign id (the id the send expects)
  name: string | null;
  status: string | null;
  client_id: string | null; // which selected client this campaign belongs to
  client_name: string | null;
  is_default: boolean; // the client's designated campaign (orch_clients.bison_campaign_id)
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
  // Campaign method has its OWN multi-select client picker showing ALL clients (independent of
  // the main filter). It's pre-seeded from the clients chosen in the filter but fully editable.
  // The chosen clients drive which campaigns are offered (grouped per client). The rows exported
  // are still the current filtered list.
  const [allClients, setAllClients] = useState<{ id: string; client_name: string | null; lead_count: number }[]>([]);
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set()); // bison_campaigns.id
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const knownCampaignIds = useRef<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cols, setCols] = useState<Set<string>>(new Set(ALL_KEYS));
  const [busy, setBusy] = useState(false);

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

  // Seed the export's client selection from the filter each time the dialog opens (editable after).
  useEffect(() => {
    if (open) setSelectedClientIds(new Set(filters.orchClientIds ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // All clients (independent of the filter) for the export's own client picker.
  useEffect(() => {
    if (!open || method !== "campaign") return;
    fetch("/api/orch/clients")
      .then((r) => r.json())
      .then((j) => setAllClients(j.clients ?? []))
      .catch(() => setAllClients([]));
  }, [open, method]);

  // Load campaigns for the currently-selected clients (grouped per client). Keeps still-valid
  // campaign picks and pre-checks the default campaign of any newly-added client.
  const clientKey = [...selectedClientIds].sort().join(",");
  useEffect(() => {
    if (!open || method !== "campaign" || selectedClientIds.size === 0) {
      setCampaigns([]);
      setSelectedCampaigns(new Set());
      knownCampaignIds.current = new Set();
      return;
    }
    setLoadingCampaigns(true);
    fetch(`/api/bison/campaigns?orchClientIds=${encodeURIComponent(clientKey)}`)
      .then((r) => r.json())
      .then((j) => {
        const list: Campaign[] = j.campaigns ?? [];
        setCampaigns(list);
        setSelectedCampaigns((prev) => {
          const present = new Set(list.map((c) => c.id));
          const next = new Set([...prev].filter((id) => present.has(id))); // keep valid picks
          for (const c of list) if (c.is_default && !knownCampaignIds.current.has(c.id)) next.add(c.id); // default-check new clients
          return next;
        });
        knownCampaignIds.current = new Set(list.map((c) => c.id));
      })
      .catch(() => {
        setCampaigns([]);
        setSelectedCampaigns(new Set());
      })
      .finally(() => setLoadingCampaigns(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method, clientKey]);

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
  const toggleCampaign = (id: string) =>
    setSelectedCampaigns((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleClient = (id: string) =>
    setSelectedClientIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Group the selected clients' campaigns under each client for the grouped multi-select.
  const campaignGroups = Object.values(
    campaigns.reduce((acc, c) => {
      const key = c.client_id ?? c.client_name ?? "unknown";
      (acc[key] ??= { clientName: c.client_name ?? "Client", items: [] as Campaign[] }).items.push(c);
      return acc;
    }, {} as Record<string, { clientName: string; items: Campaign[] }>)
  );
  const withCampaigns = new Set(campaigns.map((c) => c.client_id));
  const missingCount = [...selectedClientIds].filter((id) => !withCampaigns.has(id)).length;

  // Send to campaign: queues the merged agent list as ONE enrichment batch targeting every
  // chosen campaign (across the selected clients). The enrich-worker finds + verifies an email
  // for each agent (cached results reused), then attaches the lead to each chosen campaign,
  // skipping a campaign only if the agent is already in another campaign of that campaign's
  // own client (per-campaign, per-client dedup).
  async function sendCampaign() {
    const chosen = campaigns.filter((c) => selectedCampaigns.has(c.id));
    if (chosen.length === 0) {
      toast.error("Select at least one campaign");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/enrichment/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...reqBody(),
        orchClientIds: [...selectedClientIds],
        campaigns: chosen.map((c) => ({ id: c.bison_id, name: c.name, clientId: c.client_id })),
        sourcePriority,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(`Queued ${j.queued} agents — enriching now, then into ${chosen.length} campaign${chosen.length > 1 ? "s" : ""}. Track progress in Admin → Activity.`, { duration: 8000 });
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
      a.download = "brokerstaffer-agents.csv";
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export agents</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] min-w-0 space-y-4 overflow-y-auto pr-1">
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
              {/* Clients — multi-select, ALL clients, pre-seeded from the filter but editable */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-neutral-700">
                    Clients <span className="font-normal text-neutral-400">({selectedClientIds.size} selected)</span>
                  </label>
                  <div className="flex gap-3 text-xs">
                    <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedClientIds(new Set(allClients.map((c) => c.id)))}>
                      Select all
                    </button>
                    <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedClientIds(new Set())}>
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-3">
                  {allClients.length === 0 ? (
                    <p className="py-3 text-center text-sm text-neutral-400">No clients yet.</p>
                  ) : (
                    allClients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-neutral-800">
                        <Checkbox checked={selectedClientIds.has(c.id)} onCheckedChange={() => toggleClient(c.id)} />
                        <span className="min-w-0 flex-1 truncate" title={c.client_name ?? "Unnamed client"}>{c.client_name ?? "Unnamed client"}</span>
                        <span className="shrink-0 text-xs text-neutral-400">{(c.lead_count ?? 0).toLocaleString()} leads</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              {/* Campaigns — grouped by the selected clients */}
              {selectedClientIds.size === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-4 text-sm text-neutral-600">
                  Select one or more clients above to choose their campaigns.
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-neutral-700">
                      Campaigns <span className="font-normal text-neutral-400">({selectedCampaigns.size} selected)</span>
                    </label>
                    <div className="flex gap-3 text-xs">
                      <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedCampaigns(new Set(campaigns.map((c) => c.id)))}>
                        Select all
                      </button>
                      <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedCampaigns(new Set())}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 max-h-56 space-y-3 overflow-auto rounded-lg border border-neutral-200 p-3">
                    {loadingCampaigns ? (
                      <p className="py-4 text-center text-sm text-neutral-400">Loading campaigns…</p>
                    ) : campaigns.length === 0 ? (
                      <p className="py-4 text-center text-sm text-neutral-400">No campaigns synced for the selected client{selectedClientIds.size > 1 ? "s" : ""}.</p>
                    ) : (
                      campaignGroups.map((g) => (
                        <div key={g.clientName}>
                          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">{g.clientName}</div>
                          <div className="space-y-1">
                            {g.items.map((c) => (
                              <label key={c.id} className="flex items-center gap-2 text-sm text-neutral-800">
                                <Checkbox checked={selectedCampaigns.has(c.id)} onCheckedChange={() => toggleCampaign(c.id)} />
                                <span className="min-w-0 flex-1 truncate" title={c.name ?? c.bison_campaign_id}>{c.name ?? c.bison_campaign_id}</span>
                                {c.is_default && (
                                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">default</span>
                                )}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {missingCount > 0 && !loadingCampaigns && (
                    <p className="mt-1 text-xs text-amber-600">
                      {missingCount} selected client{missingCount > 1 ? "s have" : " has"} no synced campaigns.
                    </p>
                  )}
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-neutral-700">Data priority</label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {([["courted", "MLS"], ["zillow", "Zillow"], ["realtor", "Realtor"]] as const).map(([s, lbl]) => (
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
                  ({sourcePriority === "courted" ? "MLS → Zillow → Realtor" : sourcePriority === "zillow" ? "Zillow → MLS → Realtor" : "Realtor → MLS → Zillow"}).
                </p>
              </div>
              <p className="text-xs text-neutral-500">
                Each agent is enriched (email found + verified), then added to every selected campaign with all custom variables. A
                campaign is skipped for an agent only if they’re already in another campaign of that campaign’s client.
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
            <Button onClick={sendCampaign} disabled={busy || selectedCampaigns.size === 0}>
              {busy ? "Queueing…" : `Send to campaign${selectedCampaigns.size > 1 ? "s" : ""}`}
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
