-- 0050 (B4): cached per-view agent counts + across-all-views totals.
-- A view's count means running its whole filter — live counting on popover-open is the
-- per-request heavy-computation pattern that caused the earlier timeout incident, so
-- counts are cached on the row and refreshed at the moments membership can change:
-- view save/edit, data imports, and the 6-hourly campaign-sync safety net. The UI shows
-- the cached number with its "as of" time.
alter table saved_lists
  add column if not exists cached_count integer,
  add column if not exists cached_at timestamptz;

-- across-all-views totals (single row): distinct union (unique agents covered by at
-- least one view) + naive per-view sum, so the UI can show either.
create table if not exists saved_list_totals (
  id int primary key default 1 check (id = 1),
  union_count integer,
  sum_count bigint,
  refreshed_at timestamptz
);
insert into saved_list_totals (id) values (1) on conflict do nothing;
revoke all on table saved_list_totals from public, anon, authenticated;

create or replace function fn_refresh_saved_list_counts(p_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path to 'public'
set work_mem to '128MB'
as $$
declare
  v record;
  vwhere text;
  vf jsonb;
  n integer;
  all_ids uuid[];
begin
  for v in select id, mode, source_mode, filters from saved_lists
            where p_ids is null or id = any(p_ids) loop
    begin
      vf := coalesce(v.filters, '{}'::jsonb) - 'savedViews'; -- depth cap, same as fn_agent_where
      if v.mode = 'office' then
        vwhere := fn_office_where(vf);
        execute format('select count(*) from offices where %s', vwhere) into n;
      else
        vwhere := fn_agent_where(coalesce(v.source_mode, 'courted'), vf);
        execute format('select count(*) from agents a where %s', vwhere) into n; -- alias a: savedViews emissions reference it (0043)
      end if;
      update saved_lists set cached_count = n, cached_at = now() where id = v.id;
    exception when others then
      null; -- a broken view must not sink the rest
    end;
  end loop;

  -- totals over AGENT-mode views only (an office count summed into an agent total
  -- would be nonsense); union = agents in at least one view
  select coalesce(array_agg(id), '{}') into all_ids from saved_lists where mode is distinct from 'office';
  begin
    if array_length(all_ids, 1) is null then
      update saved_list_totals set union_count = 0, sum_count = 0, refreshed_at = now() where id = 1;
    else
      execute format('select count(*) from agents a where %s',
                     fn_agent_where('courted', jsonb_build_object('savedViews',
                       jsonb_build_object('include', to_jsonb(all_ids), 'exclude', '[]'::jsonb))))
        into n;
      update saved_list_totals
         set union_count = n,
             sum_count = (select coalesce(sum(cached_count), 0) from saved_lists where mode is distinct from 'office'),
             refreshed_at = now()
       where id = 1;
    end if;
  exception when others then
    null;
  end;
end;
$$;
revoke all on function fn_refresh_saved_list_counts(uuid[]) from public, anon, authenticated;

select fn_refresh_saved_list_counts();
