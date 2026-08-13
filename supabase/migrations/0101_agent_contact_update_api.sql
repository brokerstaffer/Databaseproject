-- 0101: update agent phone numbers from outside, by licence / email / phone, reversibly.
--
-- The existing ingest route cannot correct a phone: preferred_phone is in MERGE_FILL_COLS, so
-- for any agent carrying 'courted' in sources -- 1,131,487 of 1,135,189 -- an incoming value
-- only fills a blank and is otherwise silently discarded. That is right for a scraper and wrong
-- for a deliberate correction, so corrections get their own path.
--
-- ONLY preferred_phone is writable. Email is deliberately excluded (asked for explicitly), and
-- it stays usable as a MATCH key precisely because it is never rewritten.
--
-- preferred_phone_digits is a GENERATED column off preferred_phone, so phone search re-derives
-- itself and needs no separate maintenance.
--
-- MATCHING. The caller will not have our UUIDs, so a row is found by whatever identifier the
-- other system holds, in the same order the scraper's own matcher uses (upsert-agents.ts
-- matchKey): agent_id, then licence, then email, then phone. Measured over the live table:
--
--     key              coverage   values matching 2+ agents   worst
--     license_number   79.8%      586  (1,280 agents)         62
--     preferred_email  91.1%      27,600 (57,002 agents)      280
--     preferred_phone  84.2%      17,246 (54,936 agents)      652
--
-- 1,054,418 agents (92.9%) carry a licence or an email; 80,771 carry neither and are reachable
-- only by internal id.
--
-- AMBIGUITY UPDATES EVERY MATCH, by explicit instruction. That is worth stating plainly because
-- the collisions are concentrated in junk values, not genuine duplicates: noemail@har.com covers
-- 280 agents, training1@mredllc.com 105, and the switchboard number 18885195113 covers 652. One
-- call against any of those rewrites every one of them. Two things make that survivable:
--
--   * every affected row's previous value is recorded here BEFORE the write, and
--   * the response returns the matched count, so a caller expecting 1 and receiving 280 can tell.
--
-- A caller that wants the safer behaviour can pass max_matches and the update is refused above
-- that number instead.
--
-- REVERSING. Every call gets a batch_id and every changed row gets a history entry. Undoing a
-- batch restores the previous values and marks the entries undone, so an undo cannot be applied
-- twice. History is kept even when a value is later overwritten again -- the table is an append
-- only log, ordered by changed_at.

CREATE TABLE IF NOT EXISTS public.agent_contact_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid        NOT NULL,
  agent_id    uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  field       text        NOT NULL,
  old_value   text,
  new_value   text,
  matched_by  text        NOT NULL,   -- agent_id | license_number | email | phone
  match_value text        NOT NULL,
  changed_by  text,                   -- API key name, or the caller's supplied actor
  changed_at  timestamptz NOT NULL DEFAULT now(),
  undone_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ach_batch ON public.agent_contact_history (batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_agent ON public.agent_contact_history (agent_id, changed_at DESC);
ALTER TABLE public.agent_contact_history ENABLE ROW LEVEL SECURITY;

-- Applies a batch of phone updates. All-or-nothing per call: one failing spec aborts the whole
-- statement, so a partial batch can never be left behind.
--
-- p_updates: [ { "match": {"license_number"|"email"|"phone"|"agent_id": "..."},
--                "phone": "+1 305 555 0142",
--                "max_matches": 5 } , ... ]
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
  v_cap    int;
  v_ids    uuid[];
  v_n      int;
  v_changed int;
  v_out    jsonb := '[]'::jsonb;
begin
  for u in select value from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    v_phone := nullif(btrim(coalesce(u->>'phone', '')), '');
    v_cap   := nullif(u->>'max_matches', '')::int;

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

    if v_phone is null then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'no_phone_given',
                                           'matched_by', v_by, 'match_value', v_val);
      continue;
    end if;
    if v_n = 0 then
      v_out := v_out || jsonb_build_object('matched', 0, 'updated', 0, 'status', 'not_found',
                                           'matched_by', v_by, 'match_value', v_val);
      continue;
    end if;
    -- opt-in guard: only refuses when the caller asked for a ceiling
    if v_cap is not null and v_n > v_cap then
      v_out := v_out || jsonb_build_object('matched', v_n, 'updated', 0, 'status', 'too_many_matches',
                                           'matched_by', v_by, 'match_value', v_val,
                                           'agent_ids', to_jsonb(v_ids));
      continue;
    end if;

    -- history BEFORE the write, and only for rows whose value actually changes: re-sending the
    -- same number is a no-op rather than a log entry that would undo to itself
    insert into agent_contact_history (batch_id, agent_id, field, old_value, new_value, matched_by, match_value, changed_by)
      select p_batch, a.id, 'preferred_phone', a.preferred_phone, v_phone, v_by, v_val, p_actor
        from agents a
       where a.id = any(v_ids) and a.preferred_phone is distinct from v_phone;

    update agents a set preferred_phone = v_phone, updated_at = now()
     where a.id = any(v_ids) and a.preferred_phone is distinct from v_phone;
    get diagnostics v_changed = row_count;

    v_out := v_out || jsonb_build_object('matched', v_n, 'updated', v_changed, 'status', 'ok',
                                         'matched_by', v_by, 'match_value', v_val,
                                         'agent_ids', to_jsonb(v_ids));
  end loop;

  return jsonb_build_object('batch_id', p_batch, 'results', v_out);
end;
$function$;

-- Restores every row a batch changed. Entries already undone are skipped, so calling it twice
-- cannot roll a value back past where it started.
CREATE OR REPLACE FUNCTION public.fn_undo_agent_contact(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n int;
begin
  update agents a
     set preferred_phone = h.old_value, updated_at = now()
    from agent_contact_history h
   where h.batch_id = p_batch and h.undone_at is null
     and h.field = 'preferred_phone' and a.id = h.agent_id;
  get diagnostics v_n = row_count;

  update agent_contact_history set undone_at = now()
   where batch_id = p_batch and undone_at is null;

  return jsonb_build_object('batch_id', p_batch, 'restored', v_n);
end;
$function$;
