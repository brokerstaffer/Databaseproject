-- 0104: email may be matched by email, capped at one agent unless told otherwise.
--
-- 0103 refused any email write on an email/phone match. That protected against the placeholder
-- addresses but blocked 148,916 agents that have an email and no licence -- the operator's main
-- population, since licences exist for roughly one lead in four.
--
-- Email keys are almost always unambiguous: 977,164 of 1,004,764 addresses (97.25%) belong to
-- exactly one agent. The 27,600 that do not are placeholders -- noemail@har.com (280 agents),
-- training1@mredllc.com (105) -- which is exactly what the cap now catches.
--
-- max_matches from the caller always wins; the default of 1 applies only when it is omitted, and
-- only for an email written via an imprecise key. Phone is unchanged and uncapped.

CREATE OR REPLACE FUNCTION public.fn_update_agent_contact(p_updates jsonb, p_batch uuid, p_actor text)
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
    -- Email on an imprecise key (email / phone) is ALLOWED, but must resolve to one agent unless
    -- the caller says otherwise. Requested by the operator, who passes max_matches: 1 already.
    --
    -- The earlier rule refused these outright, which cost more than it protected: 148,916 agents
    -- have an email but no licence and so could not be corrected at all. Matching by email is
    -- almost always unambiguous -- 977,164 of 1,004,764 addresses (97.25%) belong to exactly one
    -- agent -- and the 27,600 that do not are the placeholders (noemail@har.com covers 280,
    -- training1@mredllc.com 105). So the cap catches precisely the dangerous ones.
    --
    -- An explicit max_matches always wins, including a deliberately large one for a bulk change.
    -- The default only applies when the caller did not say. Setting an email by agent_id or
    -- licence is unaffected and stays uncapped.
    if v_email is not null and v_by not in ('agent_id', 'license_number') then
      v_cap := coalesce(v_cap, 1);
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
$function$

;
