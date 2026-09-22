create table if not exists public.vehicle_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  officer_email text,
  officer_name text,
  fleet text not null check (fleet in ('TACT', 'MET')),
  vehicle text not null,
  charge_percent integer not null check (charge_percent >= 0 and charge_percent <= 100),
  location text not null check (location in ('OCT', 'GSQ')),
  created_at timestamptz not null default now()
);

alter table public.vehicle_charges enable row level security;

drop policy if exists "officers insert own charges" on public.vehicle_charges;
create policy "officers insert own charges"
  on public.vehicle_charges
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "signed in can read charges" on public.vehicle_charges;
create policy "signed in can read charges"
  on public.vehicle_charges
  for select
  to authenticated
  using (true);

grant select, insert on public.vehicle_charges to authenticated;
