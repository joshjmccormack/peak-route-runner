alter table public.profiles
  add column if not exists display_name text;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'vehicle_charges'
  ) then
    execute 'alter table public.vehicle_charges add column if not exists officer_name text';
  end if;
end $$;

drop policy if exists "update own display name" on public.profiles;
create policy "update own display name"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant update (display_name) on public.profiles to authenticated;
