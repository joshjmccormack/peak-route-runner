-- Adds the required reference number. Does not change row level security.
-- Existing rows are kept; a blank reference is filled in only where the column was null.

alter table public.job_closures
  add column if not exists reference_number text;

update public.job_closures
set reference_number = ''
where reference_number is null;

alter table public.job_closures
  alter column reference_number set not null;
