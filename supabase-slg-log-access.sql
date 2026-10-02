-- Let SLG read the vehicle charge log and the job closure log,
-- including pictures already visible to ROC and Admin.
-- Apply in the Supabase SQL editor on Parking Project (uklqyddpntttrcwaimji).
-- Safe to re-run.
--
-- Does not change inserts, profile policies, route policies, or user management.
-- ROC and Admin keep the same read access they already have.
-- Do not re-run supabase-roles.sql on production. That file resets the oldest user to admin.

drop policy if exists "roc and admin read charges" on public.vehicle_charges;
create policy "roc and admin read charges"
  on public.vehicle_charges
  for select
  to authenticated
  using (public.current_role() in ('roc', 'slg', 'admin'));

drop policy if exists "roc and admin read job closures" on public.job_closures;
create policy "roc and admin read job closures"
  on public.job_closures
  for select
  to authenticated
  using (public.current_role() in ('roc', 'slg', 'admin'));

drop policy if exists "job closure photos select" on storage.objects;
create policy "job closure photos select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'job-closures'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.current_role() in ('roc', 'slg', 'admin')
    )
  );
