-- 0103: contact updates ADD a value; they never overwrite Courted's.
--
-- 0101/0102 wrote straight into preferred_phone / preferred_email. That is wrong: those columns
-- hold the MLS (Courted) values, and Courted data must never be destroyed by an outside caller.
-- A correction is an ADDITIONAL number or address, sitting alongside the original.
--
-- The right home already exists. source_ids.agent_provided is the "someone told us this" layer:
--   * the agent profile dialog already writes it (PATCH /api/agents/profile),
--   * the table already renders it as a "provided" row under the Courted value,
--   * the top-bar search already looks inside it
--       (fn_agent_match_expr searches source_ids->'agent_provided'->>'email'), and, decisively,
--   * the enrich-worker already PREFERS it when building a Bison lead:
--
--         PRIORITY_ORDERS = {
--           courted: ["agent_provided", "courted", "zillow", "realtor"],
--           zillow:  ["agent_provided", "zillow", "courted", "realtor"],
--           realtor: ["agent_provided", "realtor", "courted", "zillow"],
--         }
--
--     byPriority() walks that order for phone, and the send resolves the email the same way
--     (byPriority(agent, order, "email", "preferred_email")). agent_provided is first in every
--     order, whatever Data priority the operator picked.
--
-- So a corrected value is used for sends and shown in the UI, while preferred_phone /
-- preferred_email keep Courted's originals untouched. That is the whole change.
--
-- Fields are merged, not replaced: setting a phone leaves a previously provided email in place,
-- and vice versa. Re-sending the same value is a no-op. Repeat calls do replace the previously
-- PROVIDED value -- that layer is ours to manage -- but never the Courted one.
--
-- History now records 'provided_phone' / 'provided_email', and old_value is the previous PROVIDED
-- value, which is NULL the first time. Undo therefore has to distinguish "put the old value back"
-- from "there was nothing here before, remove the key" -- and if removing it leaves agent_provided
-- with no phone and no email, the whole key goes, matching what the profile dialog does when both
-- fields are cleared.
--
-- Email still requires a precise match (agent_id or license_number). Nothing is destroyed now, but
-- a provided address WINS at send time, so a careless bulk write would still mail the wrong
-- people: noemail@har.com matches 280 agents.

CREATE OR REPLACE FUNCTION public.fn_update_agent_contact(
  p_updates jsonb, p_batch uuid, p_actor text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u        jsonb;
  v_by     text;
  v_val    text;
  v_phone  text;
  v_email  text;
  v_cap    int;
  v_ids    uuid[];
  v_n      int;
  v_cp     int := 0;
  v_ce     int := 0;
  v_out    jsonb := '[]'::jsonb;
begin
  for u in select value from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    v_phone := nullif(btrim(coalesce(u->>'phone', '')), '');
    v_email := lower(nullif(btrim(coalesce(u->>'email', '')), ''));
    v_cap   := nullif(u->>'max_matches', '')::int;
    v_cp := 0; v_ce := 0;

    if coalesce(u->'match'->>'agent_id', '') <> '' then
      v_by := 'agent_id'; v_val := u->'match'->>'agent_id';
      select array_agg(id) into v_ids from agents
       where id = (case when v_val ~ '^[0-9a-fA-F-]{36}$' then v_val::uuid else null end);
    elsif coalesce(u->'match'->>'license_number', '') <> '' then
      v_by := 'license_number'; v_val := u->'match'->>'license_number';
      select array_agg(id) into v_ids from agents
       where lower(btrim(license_number)) = lower(btrim(v_val)) and coalesce(btrim(license_number),'') <> '';
    elsif coalesce(u->'match'->>'email', '') <> '' then
      v_by := 'email'; v_val := u->'match'->>'email';
      -- matches the ORIGINAL address as well as a previously provided one, so an agent stays
      -- findable by whichever address the caller knows
      select array_agg(id) into v_ids from agents
       where lower(btrim(preferred_email)) = lower(btrim(v_val))
          or lower(btrim(source_ids->'agent_provided'->>'email')) = lower(btrim(v_val));
    elsif coalesce(u->'match'->>'phone', '') <> '' then
      v_by := 'phone'; v_val := u->'match'->>'phone';
      select array_agg(id) into v_ids from agents
       where preferred_phone_digits = regexp_replace(v_val, '[^0-9]', '', 'g')
          or regexp_replace(coalesce(source_ids->'agent_provided'->>'phone',''), '[^0-9]', '', 'g')
             = regexp_replace(v_val, '[^0-9]', '', 'g');
    else
      v_out := v_out || jsonb_build_object('matched', 0, 'updated', 0, 'status', 'no_match_key');
      continue;
    end if;

    v_n := coalesce(array_length(v_ids, 1), 0);

    if v_phone is null and v_email is null then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'nothing_to_set',
                                           'matched_by', v_by, 'match_value', v_val); continue;
    end if;
    if v_email is not null and v_by not in ('agent_id', 'license_number') then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0,
                                           'status', 'email_needs_precise_key',
                                           'matched_by', v_by, 'match_value', v_val); continue;
    end if;
    if v_n = 0 then
      v_out := v_out || jsonb_build_object('matched', 0, 'updated', 0, 'status', 'not_found',
                                           'matched_by', v_by, 'match_value', v_val); continue;
    end if;
    if v_cap is not null and v_n > v_cap then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'too_many_matches',
                                           'matched_by', v_by, 'match_value', v_val,
                                           'agent_ids', to_jsonb(v_ids)); continue;
    end if;

    if v_phone is not null then
      insert into agent_contact_history (batch_id, agent_id, field, old_value, new_value, matched_by, match_value, changed_by)
        select p_batch, a.id, 'provided_phone', a.source_ids->'agent_provided'->>'phone', v_phone, v_by, v_val, p_actor
          from agents a
         where a.id = any(v_ids) and (a.source_ids->'agent_provided'->>'phone') is distinct from v_phone;
      update agents a
         set source_ids = jsonb_set(coalesce(a.source_ids, '{}'::jsonb), '{agent_provided}',
               coalesce(a.source_ids->'agent_provided', '{}'::jsonb)
                 || jsonb_build_object('phone', v_phone, 'added_by', p_actor, 'added_at', to_jsonb(now())), true),
             updated_at = now()
       where a.id = any(v_ids) and (a.source_ids->'agent_provided'->>'phone') is distinct from v_phone;
      get diagnostics v_cp = row_count;
    end if;

    if v_email is not null then
      insert into agent_contact_history (batch_id, agent_id, field, old_value, new_value, matched_by, match_value, changed_by)
        select p_batch, a.id, 'provided_email', a.source_ids->'agent_provided'->>'email', v_email, v_by, v_val, p_actor
          from agents a
         where a.id = any(v_ids) and lower(coalesce(a.source_ids->'agent_provided'->>'email','')) is distinct from v_email;
      update agents a
         set source_ids = jsonb_set(coalesce(a.source_ids, '{}'::jsonb), '{agent_provided}',
               coalesce(a.source_ids->'agent_provided', '{}'::jsonb)
                 || jsonb_build_object('email', v_email, 'added_by', p_actor, 'added_at', to_jsonb(now())), true),
             updated_at = now()
       where a.id = any(v_ids) and lower(coalesce(a.source_ids->'agent_provided'->>'email','')) is distinct from v_email;
      get diagnostics v_ce = row_count;
    end if;

    v_out := v_out || jsonb_build_object('matched', v_n, 'updated', greatest(v_cp, v_ce), 'status', 'ok',
                                         'phone_updated', v_cp, 'email_updated', v_ce,
                                         'stored_as', 'source_ids.agent_provided',
                                         'matched_by', v_by, 'match_value', v_val,
                                         'agent_ids', to_jsonb(v_ids));
  end loop;

  return jsonb_build_object('batch_id', p_batch, 'results', v_out);
end;
$function$;

-- Undo, for the provided layer. Still DISTINCT ON the earliest entry per agent (a batch can touch
-- one agent more than once). Handles the legacy 'preferred_*' rows written by 0101/0102 too, so
-- any batch from before this migration can still be reversed.
CREATE OR REPLACE FUNCTION public.fn_undo_agent_contact(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_p int := 0; v_e int := 0; v_lp int := 0; v_le int := 0;
begin
  -- provided phone: restore the old value, or remove the key when there was none
  update agents a
     set source_ids = case
           when h.old_value is null then
             case when ((coalesce(a.source_ids->'agent_provided','{}'::jsonb) - 'phone') - 'added_by' - 'added_at') = '{}'::jsonb
                  then a.source_ids - 'agent_provided'
                  else jsonb_set(a.source_ids, '{agent_provided}', (a.source_ids->'agent_provided') - 'phone', true) end
           else jsonb_set(a.source_ids, '{agent_provided,phone}', to_jsonb(h.old_value), true) end,
         updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'provided_phone'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_p = row_count;

  update agents a
     set source_ids = case
           when h.old_value is null then
             case when ((coalesce(a.source_ids->'agent_provided','{}'::jsonb) - 'email') - 'added_by' - 'added_at') = '{}'::jsonb
                  then a.source_ids - 'agent_provided'
                  else jsonb_set(a.source_ids, '{agent_provided}', (a.source_ids->'agent_provided') - 'email', true) end
           else jsonb_set(a.source_ids, '{agent_provided,email}', to_jsonb(h.old_value), true) end,
         updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'provided_email'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_e = row_count;

  -- legacy batches from 0101/0102, which wrote the merged columns directly
  update agents a set preferred_phone = h.old_value, updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'preferred_phone'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_lp = row_count;

  update agents a set preferred_email = h.old_value, updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'preferred_email'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_le = row_count;

  update agent_contact_history set undone_at = now()
   where batch_id = p_batch and undone_at is null;

  return jsonb_build_object('batch_id', p_batch, 'restored', v_p + v_e + v_lp + v_le,
                            'phone_restored', v_p + v_lp, 'email_restored', v_e + v_le);
end;
$function$;
