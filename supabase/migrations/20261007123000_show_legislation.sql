-- PinAssist: TORUM Index home button (profiles.show_legislation).
-- Apply once on Parking Project (uklqyddpntttrcwaimji) after
-- supabase-home-buttons.sql. Safe to re-run.
--
-- show_legislation defaults false, so Officer, ROC, and SLG do not see TORUM
-- Index until an admin ticks it. Existing admins are turned on once, while
-- nobody else has the flag yet. New admins, and users whose role changes to
-- admin, are turned on by the trigger unless that same change sets the flag.
-- After that, the tick shows or hides the tile the same way as the other
-- home buttons, including for an admin.
--
-- A tick does not grant the job form, the charge log, or any other
-- role-gated feature, and it does not change route, charge, or job-closure
-- RLS. It does not restore routes.js.
-- Assumes table-level UPDATE on public.profiles is already revoked.

alter table public.profiles
  add column if not exists show_legislation boolean not null default false;

comment on column public.profiles.show_legislation is
  'When true, show TORUM Index on this user''s home screen. Default false. Admins start true. Does not grant role features.';

do $$
begin
  if not exists (select 1 from public.profiles where show_legislation) then
    update public.profiles
    set show_legislation = true
    where role = 'admin';
  end if;
end $$;

grant update (show_legislation) on public.profiles to authenticated;

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
