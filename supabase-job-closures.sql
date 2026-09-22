create table if not exists public.job_closures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  officer_email text,
  officer_name text,
  attendance_date date not null,
  attendance_time time not null,
  location_note text,
  officers text not null,
  observations text,
  complainant_contacted text,
  ward_office_contact text,
  media_attached text not null check (media_attached in ('yes', 'no')),
  referral text,
  reporting text,
  job_complete text not null check (job_complete in ('yes', 'no')),
  outcome text not null check (outcome in (
    'An officer has attended, and subject vehicle was not located.',
    'An officer has attended, and enforcement action was taken.',
    'An officer attended and located subject vehicle however it was assessed not to be in breach.'
  )),
  photo_path text,
  created_at timestamptz not null default now()
);

alter table public.job_closures enable row level security;

drop policy if exists "officers insert own job closures" on public.job_closures;
create policy "officers insert own job closures"
  on public.job_closures
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "roc and admin read job closures" on public.job_closures;
create policy "roc and admin read job closures"
  on public.job_closures
  for select
  to authenticated
  using (public.current_role() in ('roc', 'admin'));

grant select, insert on public.job_closures to authenticated;
