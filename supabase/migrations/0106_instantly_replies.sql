-- 0106: mirror Instantly replies, and give both providers one place to answer "has this agent
-- replied to us".
--
-- Until now "replied" meant "replied in EmailBison" -- the flag lives on bison_client_leads and is
-- set by the 6-hourly Bison sync. Campaigns also run in Instantly, and agents reply there, so the
-- app has been understating reality. Measured against the live workspace before writing this:
--
--     unique replied emails in Instantly                        3,957
--     of those, matching an agent (preferred or enriched email)  2,055
--     of those emails, present in bison_client_leads at all        619
--     already flagged replied via Bison                            255
--
-- So roughly 1,800 agent replies were invisible. Anyone using the Replied filter to avoid
-- re-contacting a warm lead was working from half the picture.
--
-- SCOPE: replies only. No bounce sweep, no campaign-membership mirror -- has_bounced,
-- campaign_count and client_campaigns keep reading bison_client_leads alone.
--
-- A SEPARATE TABLE, not a provider column on bison_client_leads. Four reasons:
--   * the reaper in bison-sync (delete ... where campaign_id <> all($1)) would delete every
--     Instantly row on the next Bison run. A separate table is structurally immune.
--   * bison_client_leads.client_id is NOT NULL. Instantly has campaigns that map to no client at
--     all ("Campaign #1: Personal Emails"), and those replies would have to be dropped. Here
--     client_id is nullable, so the reply is kept even when attribution fails.
--   * every SQL function hardcodes the table name either way, so a provider column saves no edits.
--   * no migration on a hot 110k-row table that a live job rewrites every six hours.
--
-- The cost is one UNION in the view below, which is cheap and keeps the two syncs independent.

CREATE TABLE IF NOT EXISTS public.instantly_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   text NOT NULL,                    -- Instantly campaign uuid
  campaign_name text,
  -- nullable on purpose: a reply is worth keeping even if its campaign maps to no client
  client_id     uuid REFERENCES public.orch_clients(id) ON DELETE SET NULL,
  email         text NOT NULL,
  agent_id      uuid,                             -- resolved by email; null = not in our DB
  reply_count   int,
  last_reply_at timestamptz,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS idx_instantly_replies_agent ON public.instantly_replies (agent_id);
CREATE INDEX IF NOT EXISTS idx_instantly_replies_client ON public.instantly_replies (client_id);

-- pool-role only, matching bison_client_leads (0038): the app reads this through SECURITY DEFINER
-- functions, never directly from the browser
REVOKE ALL ON public.instantly_replies FROM public, anon, authenticated;

-- THE choke point. Every "has this agent replied" question in the app resolves through this view,
-- so adding a third provider later means changing this one object and nothing else.
--
-- The "agent_id is not null" guards are load-bearing, not tidiness: fn_agent_where implements the
-- "Not replied" filter as `id not in (select agent_id from v_replied_agents)`, and a single NULL
-- in a NOT IN makes the whole predicate return no rows. Do not remove them.
CREATE OR REPLACE VIEW public.v_replied_agents AS
  SELECT DISTINCT agent_id FROM public.bison_client_leads WHERE replied AND agent_id IS NOT NULL
  UNION
  SELECT DISTINCT agent_id FROM public.instantly_replies  WHERE agent_id IS NOT NULL;

REVOKE ALL ON public.v_replied_agents FROM public, anon, authenticated;
