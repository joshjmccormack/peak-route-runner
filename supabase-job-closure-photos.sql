alter table public.job_closures
  add column if not exists photo_path text;

insert into storage.buckets (id, name, public)
values ('job-closures', 'job-closures', false)
on conflict (id) do nothing;

drop policy if exists "job closure photos insert" on storage.objects;
create policy "job closure photos insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'job-closures'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "job closure photos select" on storage.objects;
create policy "job closure photos select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'job-closures'
    and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.current_role() in ('roc', 'admin')
    )
  );
