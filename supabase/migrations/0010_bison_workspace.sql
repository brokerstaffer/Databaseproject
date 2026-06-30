-- 0010_bison_workspace.sql
-- EmailBison campaigns now come from ONE shared workspace (single key) and are tied to a
-- client by campaign-NAME prefix ("Client Name + Sender + Market"), not by a per-client key.
-- So client_id is no longer required, and campaigns dedupe by bison_campaign_id alone.

truncate table bison_campaigns;
alter table bison_campaigns alter column client_id drop not null;
create unique index if not exists ux_bison_campaigns_campaign on bison_campaigns (bison_campaign_id);
