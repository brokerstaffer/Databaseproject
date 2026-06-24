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
