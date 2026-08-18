-- 0110: indexes for the two-provider campaign union, added BEFORE the membership sweep lands.
--
-- 0109 pointed campaign_count, the multi-campaign filter and the in-campaign filter at
-- v_agent_campaigns, a UNION ALL over both mirrors. Measured right after 0109, with
-- instantly_client_leads still holding only the 7,875 replies-only rows, everything was in band:
--
--     landing              323 ms  (was 320)      sort_campaign_count    865 ms  (was 1,920)
--     f_multicampaign      419 ms  (was 497)      sort_client_campaigns  891 ms  (was 1,947)
--     f_incampaign_has     555 ms  (was 331)      f_bounced_has           63 ms  (was 56)
--
-- But the first membership sync takes that table from 7,875 rows to ~168,000, so the union goes
-- from ~122k rows to ~282k. The two heaviest shapes over it are a GROUP BY agent_id with
-- count(distinct campaign_id) (multiCampaign, campaign_count) and a DISTINCT agent_id scan
-- (inCampaign) -- both of which can be answered index-only from (agent_id, campaign_id), and
-- neither of which can use idx_bcl_agent / idx_icl_agent for the campaign_id half today.
--
-- Adding these now rather than reacting afterwards keeps the first post-sync page loads fast for
-- whoever is using the app when the data lands. Purely additive: no existing index is touched, per
-- the standing constraint that pre-existing indexes are never dropped.

CREATE INDEX IF NOT EXISTS idx_bcl_agent_campaign
  ON public.bison_client_leads (agent_id, campaign_id) WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_icl_agent_campaign
  ON public.instantly_client_leads (agent_id, campaign_id) WHERE agent_id IS NOT NULL;

-- v_replied_agents and v_bounced_agents scan `where <flag> and agent_id is not null`. The Instantly
-- side already got these in 0108; the Bison side has only the plain idx_bcl_agent, so a replied
-- lookup reads all 114k rows to find ~5.4k. Both sets are small, which is exactly when a partial
-- index pays.
CREATE INDEX IF NOT EXISTS idx_bcl_replied ON public.bison_client_leads (agent_id) WHERE replied;
CREATE INDEX IF NOT EXISTS idx_bcl_bounced ON public.bison_client_leads (agent_id) WHERE bounced;

ANALYZE public.bison_client_leads;
ANALYZE public.instantly_client_leads;
