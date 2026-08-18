-- 0108: Instantly gets the same shape as EmailBison -- campaign membership and a bounced flag,
-- not just replies -- plus one view that answers "where did this reply come from".
--
-- 0106 deliberately scoped Instantly to replies only, and said so in its own header: "has_bounced,
-- campaign_count and client_campaigns keep reading bison_client_leads alone". Two consequences of
-- that scope are now being closed.
--
-- 1. NOTHING IN THE APP SHOWS WHERE A REPLY CAME FROM. v_replied_agents flattens both providers to
--    a bare agent_id set, the Replied cell renders a constant tick, and campaign_name / client_id /
--    reply_count / last_reply_at on this table were written every sync and read by nothing. An
--    agent whose only reply came from Instantly showed a tick with an em dash beside it and no
--    explanation.
--
-- 2. BOUNCES AND MEMBERSHIP WERE EMAILBISON-ONLY. Measured live against the Instantly API before
--    writing this:
--
--        bounced leads                        6,499 unique emails / 165 campaigns / 39 s
--          of those, resolving to an agent    2,031
--          bounced agents today               2,342   ->  3,712 after   (+59%)
--
--        campaign membership                149,140 unique emails / 212 campaigns / 14 min
--          of those, resolving to an agent   72,466
--          agents in a campaign today        59,731   -> 117,971 after
--          of those, in Instantly but in NO Bison campaign        58,240
--
--    That last number is the point: 58,240 agents read as "not in campaign" while being actively
--    emailed through Instantly. Anyone using that filter to avoid re-contacting was working from
--    half the picture, exactly as with replies before 0106.
--
-- WHY RENAME RATHER THAN ADD A TABLE. The table now holds every campaign member, not just repliers,
-- so "instantly_replies" would be an actively misleading name -- and one table per provider keeps
-- the SQL symmetrical with bison_client_leads, so a third provider is a copy of the pattern rather
-- than a new shape. A rename preserves every row and Postgres re-points dependent objects by OID,
-- so v_replied_agents below follows it automatically.
--
-- ORDERING: the deployed instantly-sync writes `instantly_replies` by name, so this migration ships
-- WITH the rewritten route. If a sync fires in the gap it throws before its DELETE, failing loudly
-- with a FAILED audit row and losing nothing.

ALTER TABLE IF EXISTS public.instantly_replies RENAME TO instantly_client_leads;
ALTER INDEX IF EXISTS idx_instantly_replies_agent  RENAME TO idx_icl_agent;
ALTER INDEX IF EXISTS idx_instantly_replies_client RENAME TO idx_icl_client;

-- Both default false and are set by the sweeps. The sync builds every row with its flags ALREADY
-- resolved and replaces the table in one transaction, so unlike the Bison mirror there is never a
-- window where a member exists with its flags still at the default.
ALTER TABLE public.instantly_client_leads
  ADD COLUMN IF NOT EXISTS replied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bounced boolean NOT NULL DEFAULT false;

-- Every row that exists right now came from the replies-only sweep, so every one of them IS a
-- reply. Without this backfill the rename would silently turn 7,875 replies into 7,875 plain
-- members and drop ~4,346 agents out of the Replied filter until the first new sync landed.
UPDATE public.instantly_client_leads SET replied = true WHERE NOT replied;

CREATE INDEX IF NOT EXISTS idx_icl_replied ON public.instantly_client_leads (agent_id) WHERE replied;
CREATE INDEX IF NOT EXISTS idx_icl_bounced ON public.instantly_client_leads (agent_id) WHERE bounced;

-- Lookups BY EMAIL had no usable index on either mirror. bison_client_leads is
-- unique (client_id, campaign_id, email) and this table was unique (campaign_id, email), so an
-- email-only predicate could only skip-scan the leading columns -- measured at 180 ms per campaign
-- for the flag carry-over added to bison-sync yesterday. At Instantly's 149k-row membership that
-- is no longer acceptable.
CREATE INDEX IF NOT EXISTS idx_icl_email ON public.instantly_client_leads (email);
CREATE INDEX IF NOT EXISTS idx_bcl_email ON public.bison_client_leads (email);

REVOKE ALL ON public.instantly_client_leads FROM public, anon, authenticated;

-- THE choke point, unchanged in purpose. Its Instantly leg now needs `replied` because the table
-- holds non-repliers too; before the rename, membership in this table WAS the reply.
--
-- The "agent_id is not null" guards are load-bearing, not tidiness: fn_agent_where implements
-- "Not replied" as `id not in (select agent_id from v_replied_agents)`, and a single NULL in a
-- NOT IN makes the whole predicate return no rows. Do not remove them.
CREATE OR REPLACE VIEW public.v_replied_agents AS
  SELECT DISTINCT agent_id FROM public.bison_client_leads     WHERE replied AND agent_id IS NOT NULL
  UNION
  SELECT DISTINCT agent_id FROM public.instantly_client_leads WHERE replied AND agent_id IS NOT NULL;

-- Same shape for bounced and for membership, so fn_agent_where / fn_agent_order name one object
-- instead of repeating a UNION at five call sites. Same NULL guard, same reason.
CREATE OR REPLACE VIEW public.v_bounced_agents AS
  SELECT DISTINCT agent_id FROM public.bison_client_leads     WHERE bounced AND agent_id IS NOT NULL
  UNION
  SELECT DISTINCT agent_id FROM public.instantly_client_leads WHERE bounced AND agent_id IS NOT NULL;

CREATE OR REPLACE VIEW public.v_campaign_agents AS
  SELECT DISTINCT agent_id FROM public.bison_client_leads     WHERE agent_id IS NOT NULL
  UNION
  SELECT DISTINCT agent_id FROM public.instantly_client_leads WHERE agent_id IS NOT NULL;

-- One row per (agent, campaign) across both providers, so campaign_count and the multi-campaign
-- filter can count distinct campaigns without repeating the union. UNION ALL is safe and cheaper
-- than UNION here: campaign_id is a Bison numeric id on one side and an Instantly uuid on the
-- other, so the two legs cannot collide.
CREATE OR REPLACE VIEW public.v_agent_campaigns AS
  SELECT agent_id, campaign_id, campaign_name, client_id, 'EmailBison'::text AS provider
    FROM public.bison_client_leads     WHERE agent_id IS NOT NULL
  UNION ALL
  SELECT agent_id, campaign_id, campaign_name, client_id, 'Instantly'::text
    FROM public.instantly_client_leads WHERE agent_id IS NOT NULL;

-- Reply provenance: the two columns the agent table renders immediately left of Replied.
--
-- Sourced from the campaigns the agent actually REPLIED in, not every campaign they are a member
-- of -- "where did this reply come from" is the question, so a member who never replied
-- contributes nothing here and the columns read as empty, matching the em dash the Replied cell
-- shows for them.
CREATE OR REPLACE VIEW public.v_agent_reply_sources AS
  SELECT agent_id,
         string_agg(DISTINCT provider,      ', ' ORDER BY provider)      AS reply_providers,
         string_agg(DISTINCT campaign_name, ', ' ORDER BY campaign_name) AS reply_campaigns
    FROM (SELECT agent_id, 'EmailBison'::text AS provider, campaign_name
            FROM public.bison_client_leads     WHERE replied AND agent_id IS NOT NULL
          UNION ALL
          SELECT agent_id, 'Instantly'::text, campaign_name
            FROM public.instantly_client_leads WHERE replied AND agent_id IS NOT NULL) s
   GROUP BY agent_id;

REVOKE ALL ON public.v_replied_agents,     public.v_bounced_agents, public.v_campaign_agents,
              public.v_agent_reply_sources, public.v_agent_campaigns
  FROM public, anon, authenticated;
