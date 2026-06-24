-- 0003_auth_profile_trigger.sql
-- Auto-create a user_profiles row when a Supabase auth user is created.
-- Lets you add login users from the Supabase dashboard (Authentication -> Users).
-- Idempotent.

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into user_profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'owner')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function handle_new_user();
