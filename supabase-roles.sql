create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  officer_code text,
  role text not null default 'officer' check (role in ('officer', 'roc', 'admin'))
);

alter table public.profiles enable row level security;

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'officer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

insert into public.profiles (id, email, role)
select id, email, 'officer' from auth.users
on conflict (id) do nothing;

update public.profiles
set role = 'admin'
where id = (
  select id from auth.users order by created_at asc limit 1
);

drop policy if exists "read own or admin reads profiles" on public.profiles;
create policy "read own or admin reads profiles"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid() or public.current_role() = 'admin');

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant execute on function public.current_role() to authenticated;

drop policy if exists "update own display name" on public.profiles;
create policy "update own display name"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'vehicle_charges'
  ) then
    execute 'drop policy if exists "signed in can read charges" on public.vehicle_charges';
    execute 'drop policy if exists "roc and admin read charges" on public.vehicle_charges';
    execute $p$
      create policy "roc and admin read charges"
        on public.vehicle_charges
        for select
        to authenticated
        using (public.current_role() in ('roc', 'admin'))
    $p$;
  end if;
end $$;
