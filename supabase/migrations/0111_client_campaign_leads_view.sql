-- 0111: one view for the per-client sequencer counts on the Clients page.
--
-- /api/orch/clients counts leads, matched agents, replies and bounces per client. Those four
-- subqueries read bison_client_leads alone, which is why the page's headers had to say
-- "Replied (Bison)" / "Bounced (Bison)" — they would otherwise have contradicted the agent table,
-- which has covered both providers since 0107. Now that Instantly membership is mirrored, the
-- counts can cover both and the qualifier can go.
--
-- WHY NOT v_agent_campaigns: that view filters `agent_id is not null`, because everything it feeds
-- keys off an agent. These counts are per EMAIL — "how many leads of this client are in a
-- sequencer at all", including the ones we hold no agent record for. Reusing it would silently
-- undercount every client by exactly the unmatched leads, which is the number the page exists to
-- show against `bison_matched`.
--
-- Instantly rows whose campaign matched no client carry client_id = null and so belong to no
-- client here. That is correct: they have no client to be counted under. They remain visible in
-- the agent table, which keys off agent_id rather than client_id.
CREATE OR REPLACE VIEW public.v_client_campaign_leads AS
  SELECT client_id, campaign_id, campaign_name, email, agent_id, replied, bounced, synced_at,
         'EmailBison'::text AS provider
    FROM public.bison_client_leads
  UNION ALL
  SELECT client_id, campaign_id, campaign_name, email, agent_id, replied, bounced, synced_at,
         'Instantly'::text
    FROM public.instantly_client_leads;

REVOKE ALL ON public.v_client_campaign_leads FROM public, anon, authenticated;

-- the per-client subqueries all filter on client_id
CREATE INDEX IF NOT EXISTS idx_icl_client_email ON public.instantly_client_leads (client_id, email);
CREATE INDEX IF NOT EXISTS idx_bcl_client_email ON public.bison_client_leads (client_id, email);
