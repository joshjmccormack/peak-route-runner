-- Home button visibility, per user.
--
-- Apply this file manually in the Parking Project Supabase SQL editor
-- (project ref uklqyddpntttrcwaimji, https://pinassist.app).
-- PinAssist does not apply it. Do not re-run supabase-roles.sql.
--
-- Peak Routes, Run Maps, Vehicles, and Job closures default true, so existing
-- users keep those buttons until an admin unticks one.
-- show_legislation defaults false. Officer, ROC, and SLG do not see TORUM Index
-- until an admin ticks it. Existing admins are turned on once. New admins are
-- turned on by the trigger unless that same change sets the flag.
-- A tick only shows or hides a home button. It does not grant ROC or SLG the
-- job form, the charge log, or any other role-gated feature, and it does not
-- change route, charge, or job-closure RLS. It does not restore routes.js.
--
-- Assumes supabase-profile-updates.sql has already revoked table-level UPDATE.
-- This file repeats that revoke so role, email, and officer_code stay off the
-- client, then grants the flag columns. Admins save ticks from the users
-- table with their own JWT. The trigger rejects flag changes from anyone else.
-- create-user and update-user keep using the service role and do not need a redeploy.

alter table public.profiles
  add column if not exists show_peak_routes boolean not null default true,
  add column if not exists show_run_maps boolean not null default true,
  add column if not exists show_vehicles boolean not null default true,
  add column if not exists show_job_closures boolean not null default true,
  add column if not exists show_legislation boolean not null default false;

do $$
begin
  if not exists (select 1 from public.profiles where show_legislation) then
    update public.profiles
    set show_legislation = true
    where role = 'admin';
  end if;
end $$;

comment on column public.profiles.show_peak_routes is
  'When false, hide Peak Routes on this user''s home screen. Default true. Does not grant access.';
comment on column public.profiles.show_run_maps is
  'When false, hide Run Maps on this user''s home screen. Default true. Does not grant access.';
comment on column public.profiles.show_vehicles is
  'When false, hide Vehicles on this user''s home screen. Default true. Does not grant access.';
comment on column public.profiles.show_job_closures is
  'When false, hide Job closures on this user''s home screen. Default true. Does not grant the job form.';
comment on column public.profiles.show_legislation is
  'When true, show TORUM Index on this user''s home screen. Default false. Admins start true. Does not grant role features.';

revoke update on table public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
grant update (
  show_peak_routes,
  show_run_maps,
  show_vehicles,
  show_job_closures,
  show_legislation
) on public.profiles to authenticated;

drop policy if exists "admin updates home buttons" on public.profiles;
create policy "admin updates home buttons"
  on public.profiles
  for update
  to authenticated
  using ((select public.current_role()) = 'admin')
  with check ((select public.current_role()) = 'admin');

create or replace function public.protect_profile_home_buttons()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.show_peak_routes is not distinct from old.show_peak_routes
     and new.show_run_maps is not distinct from old.show_run_maps
     and new.show_vehicles is not distinct from old.show_vehicles
     and new.show_job_closures is not distinct from old.show_job_closures
     and new.show_legislation is not distinct from old.show_legislation then
    return new;
  end if;

  -- Service role (edge functions) and the SQL editor may write profiles.
  -- Signed-in admins may change the home-button flags. Nobody else may.
  if current_user in ('service_role', 'postgres', 'supabase_admin')
     or (select public.current_role()) = 'admin' then
    return new;
  end if;

  raise exception 'Only an admin can change home buttons';
end;
$$;

revoke all on function public.protect_profile_home_buttons() from public, anon, authenticated;
grant execute on function public.protect_profile_home_buttons() to authenticated, service_role;

drop trigger if exists protect_profile_home_buttons on public.profiles;
create trigger protect_profile_home_buttons
  before update on public.profiles
  for each row execute procedure public.protect_profile_home_buttons();

create or replace function public.default_show_legislation_for_admin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.role = 'admin' then
      new.show_legislation := true;
    end if;
    return new;
  end if;

  if new.role = 'admin'
     and old.role is distinct from 'admin'
     and new.show_legislation is not distinct from old.show_legislation then
    new.show_legislation := true;
  end if;
  return new;
end;
$$;

revoke all on function public.default_show_legislation_for_admin() from public, anon, authenticated;
grant execute on function public.default_show_legislation_for_admin() to authenticated, service_role;

drop trigger if exists default_show_legislation_for_admin on public.profiles;
create trigger default_show_legislation_for_admin
  before insert or update on public.profiles
  for each row execute procedure public.default_show_legislation_for_admin();
