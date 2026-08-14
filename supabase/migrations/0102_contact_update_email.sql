-- 0102: the contact update API can set preferred_email too, but only on a precise match.
--
-- 0101 deliberately refused email writes. Email is now writable, with one restriction: the agent
-- must have been found by agent_id or license_number, never by email or phone.
--
-- That restriction is the whole safety model, and it is worth stating why. These identifiers are
-- not unique in this data:
--
--     key              values matching 2+ agents   worst single value
--     license_number   586   (1,280 agents)        62
--     preferred_email  27,600 (57,002 agents)      280  (noemail@har.com)
--     preferred_phone  17,246 (54,936 agents)      652  (a switchboard)
--
-- Since every match is updated, rewriting email while matching BY email is the one combination
-- that can quietly destroy data at scale: one call against noemail@har.com would give 280 agents
-- the same new address, and the old values are then the only way back. Matching by licence keeps
-- that blast radius at the 586 known-bad licences, which are visibly placeholders (000000,
-- 000000sec). agent_id is exact and always allowed.
--
-- A request that asks to set an email on an email/phone match is REFUSED per spec with
-- status 'email_needs_precise_key' and changes nothing -- not even the phone in the same spec,
-- so a partially-applied update never happens.
--
-- Coverage: 905,502 agents carry a licence, of which 20,252 have no email at all (so this is
-- also how a missing address gets filled).
--
-- KNOWN SIDE EFFECT, not prevented here because it is a legitimate thing to want: the Bison sync
-- links campaign leads to agents by lower(preferred_email). 53,533 licensed agents are currently
-- linked to campaign leads; changing one of those addresses means the next sync re-matches that
-- lead by the NEW address and no longer finds it under the old one, so the agent can lose its
-- in-campaign / replied / bounced flags until Bison holds the new address too. Undo restores the
-- address and the link comes back on the following sync.
--
-- preferred_email has no unique constraint and no dependent generated column; the two email
-- indexes are expression indexes on lower(...) and maintain themselves.

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

    -- identifier waterfall, strongest first (mirrors the scraper's matchKey)
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
      select array_agg(id) into v_ids from agents
       where lower(btrim(preferred_email)) = lower(btrim(v_val)) and coalesce(btrim(preferred_email),'') <> '';
    elsif coalesce(u->'match'->>'phone', '') <> '' then
      v_by := 'phone'; v_val := u->'match'->>'phone';
      select array_agg(id) into v_ids from agents
       where preferred_phone_digits = regexp_replace(v_val, '[^0-9]', '', 'g')
         and coalesce(preferred_phone_digits,'') <> '';
    else
      v_out := v_out || jsonb_build_object('matched', 0, 'updated', 0, 'status', 'no_match_key');
      continue;
    end if;

    v_n := coalesce(array_length(v_ids, 1), 0);

    if v_phone is null and v_email is null then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'nothing_to_set',
                                           'matched_by', v_by, 'match_value', v_val);
      continue;
    end if;
    -- email only on a precise key; refuse the WHOLE spec so nothing is half-applied
    if v_email is not null and v_by not in ('agent_id', 'license_number') then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0,
                                           'status', 'email_needs_precise_key',
                                           'matched_by', v_by, 'match_value', v_val);
      continue;
    end if;
    if v_n = 0 then
      v_out := v_out || jsonb_build_object('matched', 0, 'updated', 0, 'status', 'not_found',
                                           'matched_by', v_by, 'match_value', v_val);
      continue;
    end if;
    if v_cap is not null and v_n > v_cap then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'too_many_matches',
                                           'matched_by', v_by, 'match_value', v_val,
                                           'agent_ids', to_jsonb(v_ids));
      continue;
    end if;

    -- history BEFORE each write, and only where the value actually changes, so re-sending the
    -- same value is a no-op rather than an entry that would undo to itself
    if v_phone is not null then
      insert into agent_contact_history (batch_id, agent_id, field, old_value, new_value, matched_by, match_value, changed_by)
        select p_batch, a.id, 'preferred_phone', a.preferred_phone, v_phone, v_by, v_val, p_actor
          from agents a where a.id = any(v_ids) and a.preferred_phone is distinct from v_phone;
      update agents a set preferred_phone = v_phone, updated_at = now()
       where a.id = any(v_ids) and a.preferred_phone is distinct from v_phone;
      get diagnostics v_cp = row_count;
    end if;

    if v_email is not null then
      insert into agent_contact_history (batch_id, agent_id, field, old_value, new_value, matched_by, match_value, changed_by)
        select p_batch, a.id, 'preferred_email', a.preferred_email, v_email, v_by, v_val, p_actor
          from agents a where a.id = any(v_ids) and lower(coalesce(a.preferred_email,'')) is distinct from v_email;
      update agents a set preferred_email = v_email, updated_at = now()
       where a.id = any(v_ids) and lower(coalesce(a.preferred_email,'')) is distinct from v_email;
      get diagnostics v_ce = row_count;
    end if;

    v_out := v_out || jsonb_build_object('matched', v_n, 'updated', greatest(v_cp, v_ce), 'status', 'ok',
                                         'phone_updated', v_cp, 'email_updated', v_ce,
                                         'matched_by', v_by, 'match_value', v_val,
                                         'agent_ids', to_jsonb(v_ids));
  end loop;

  return jsonb_build_object('batch_id', p_batch, 'results', v_out);
end;
$function$;

-- Undo restores whichever field each history row recorded, not just the phone.
--
-- DISTINCT ON picks the EARLIEST entry per (agent, field). A single batch can touch the same
-- agent twice -- duplicate specs in one call, or a spec that matches an agent already matched by
-- an earlier one -- which leaves two history rows for that agent and field. Joining them without
-- an order lets Postgres choose either, so undo would sometimes restore the mid-batch value
-- instead of the value from before the batch ran. Found in testing, where a batch wrote a phone
-- twice and undo happened to pick the right row. Ordering by changed_at makes it the value the
-- agent had before this batch touched it, every time.
CREATE OR REPLACE FUNCTION public.fn_undo_agent_contact(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_p int; v_e int;
begin
  update agents a set preferred_phone = h.old_value, updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value
            from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'preferred_phone'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_p = row_count;

  update agents a set preferred_email = h.old_value, updated_at = now()
    from (select distinct on (agent_id) agent_id, old_value
            from agent_contact_history
           where batch_id = p_batch and undone_at is null and field = 'preferred_email'
           order by agent_id, changed_at asc, id asc) h
   where a.id = h.agent_id;
  get diagnostics v_e = row_count;

  update agent_contact_history set undone_at = now()
   where batch_id = p_batch and undone_at is null;

  return jsonb_build_object('batch_id', p_batch, 'restored', v_p + v_e,
                            'phone_restored', v_p, 'email_restored', v_e);
end;
$function$;
