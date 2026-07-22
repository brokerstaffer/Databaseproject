// EmailBison "List campaigns" client. GET {base}/campaigns with Bearer auth,
// length-aware pagination. Returns normalized campaign rows for bison_campaigns.
export interface BisonCampaign {
  bison_campaign_id: string;
  name: string | null;
  status: string | null;
  raw: unknown;
}

export async function fetchClientCampaigns(apiKey: string, base: string): Promise<BisonCampaign[]> {
  const root = base.replace(/\/+$/, "");
  const out: BisonCampaign[] = [];
  const MAX_PAGES = 50;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${root}/campaigns?pagination_type=length_aware&page=${page}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`EmailBison ${res.status} ${res.statusText}`);
    const json = await res.json();
    const data: Record<string, unknown>[] = Array.isArray(json?.data) ? json.data : [];
    for (const c of data) {
      out.push({
        bison_campaign_id: String(c.uuid ?? c.id),
        name: (c.name as string) ?? null,
        status: (c.status as string) ?? null,
        raw: c,
      });
    }
    const lastPage = (json?.meta?.last_page ?? json?.last_page) as number | undefined;
    if (data.length === 0 || (lastPage && page >= lastPage)) break;
    if (!lastPage) break; // single page / unknown pagination
  }
  return out;
}

// Campaign membership: every lead currently in a campaign. Same auth + length-aware
// pagination as fetchClientCampaigns. Returns minimal rows for bison_client_leads.
export interface BisonCampaignLead {
  bison_lead_id: string | null;
  email: string;
}

export async function fetchCampaignLeads(apiKey: string, base: string, campaignId: string): Promise<BisonCampaignLead[]> {
  const root = base.replace(/\/+$/, "");
  const out: BisonCampaignLead[] = [];
  const MAX_PAGES = 1000;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${root}/campaigns/${campaignId}/leads?pagination_type=length_aware&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`EmailBison campaign ${campaignId} leads ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (!Array.isArray(json?.data)) throw new Error(`EmailBison campaign ${campaignId}: unexpected response shape`); // error-in-200 must NOT read as "campaign is empty"
    const data: Record<string, unknown>[] = json.data;
    for (const l of data) {
      const email = String(l.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) continue;
      out.push({ bison_lead_id: l.id != null ? String(l.id) : null, email });
    }
    const lastPage = (json?.meta?.last_page ?? json?.last_page) as number | undefined;
    if (data.length === 0 || (lastPage && page >= lastPage)) break;
    if (!lastPage) {
      // no pagination info: a full page means there may be more we cannot reach — refuse to
      // return a silently-truncated list (the caller REPLACES rows with what we return)
      if (data.length >= 100) throw new Error(`EmailBison campaign ${campaignId}: pagination shape unknown with a full page`);
      break;
    }
    if (page === MAX_PAGES) throw new Error(`EmailBison campaign ${campaignId}: exceeded ${MAX_PAGES} pages`);
  }
  return out;
}
