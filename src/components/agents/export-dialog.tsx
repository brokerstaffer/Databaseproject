"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";

interface ClientOpt {
  id: string;
  name: string;
  clay_webhook_url: string | null;
}
interface Campaign {
  id: string;
  bison_campaign_id: string;
  name: string | null;
  status: string | null;
}

export function ExportDialog({
  open,
  onOpenChange,
  filters,
  total,
  selectedIds,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: Filters;
  total: number;
  selectedIds: string[];
}) {
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [clientId, setClientId] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) {
      fetch("/api/clients")
        .then((r) => r.json())
        .then((j) => setClients(j.clients ?? []));
    }
  }, [open]);

  useEffect(() => {
    if (clientId) {
      fetch(`/api/bison/campaigns?clientId=${clientId}`)
        .then((r) => r.json())
        .then((j) => setCampaigns(j.campaigns ?? []));
      setCampaignId("");
    } else {
      setCampaigns([]);
    }
  }, [clientId]);

  const selectedClient = clients.find((c) => c.id === clientId);
  const scope =
    selectedIds.length > 0 ? `${selectedIds.length} selected` : from || to ? `rows ${from || 1}–${to || total}` : `all ${total.toLocaleString()}`;

  async function send() {
    if (!clientId) {
      toast.error("Select a client");
      return;
    }
    setSending(true);
    const campaign = campaigns.find((c) => c.id === campaignId);
    const res = await fetch("/api/integrations/clay/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        campaignId: campaign?.bison_campaign_id ?? null,
        campaignName: campaign?.name ?? null,
        filters,
        selectedIds: selectedIds.length ? selectedIds : undefined,
        rangeFrom: from || undefined,
        rangeTo: to || undefined,
      }),
    });
    setSending(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(`Sent ${j.sent} agents to ${j.client}'s Clay`);
      onOpenChange(false);
    } else {
      toast.error(j.error ?? "Send failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export — Send to Clay</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-neutral-700">Client</label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedClient && !selectedClient.clay_webhook_url && (
              <p className="mt-1 text-xs text-red-600">This client has no Clay webhook — add one on the Webhooks page.</p>
            )}
            {clients.length === 0 && <p className="mt-1 text-xs text-neutral-500">No clients yet — add one on the Webhooks page.</p>}
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
            <label className="text-sm font-medium text-neutral-700">
              Range <span className="font-normal text-neutral-400">(blank = all filtered)</span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" inputMode="numeric" />
              <span className="text-neutral-400">–</span>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" inputMode="numeric" />
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Sending: <span className="font-medium text-neutral-700">{scope}</span> agents
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || !clientId}>
            {sending ? "Sending…" : "Send to Clay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
