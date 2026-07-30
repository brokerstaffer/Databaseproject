-- 0067: which MLSs actually appear in a given agent set (the current filter, or an
-- explicit selection) — powers the send dialog's "MLS data to send" list so it offers
-- only the selected agents' MLSs instead of all 34.
create or replace function fn_mls_in_set(p_source text, p_filters jsonb, p_agent_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
set work_mem to '128MB'
as $$
declare v_where text; res jsonb;
begin
  if p_agent_ids is not null and array_length(p_agent_ids, 1) > 0 then
    v_where := format('a.id = any(%L::uuid[])', p_agent_ids);
  else
    v_where := fn_agent_where(p_source, p_filters);
  end if;
  -- the WHERE references bare agent columns, so it must be evaluated with ONLY agents in
  -- scope (mls.id would make a bare `id` ambiguous) — hence the sel CTE
  execute format($q$
    with sel as (select a.id from agents a where %s)
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'code', t.code, 'name', t.name, 'agents', t.n, 'ready', t.ready) order by t.n desc, t.code), '[]'::jsonb)
      from (
        select m.id, m.code, m.name, count(*)::int as n,
               coalesce(m.stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(m.member_agents, 0), 1) as ready
          from sel
          join agent_mls am on am.agent_id = sel.id
          join mls m on m.id = am.mls_id
         group by m.id, m.code, m.name, m.stats_agents, m.member_agents
      ) t
  $q$, v_where) into res;
  return res;
end;
$$;
revoke all on function fn_mls_in_set(text, jsonb, uuid[]) from public, anon, authenticated;
