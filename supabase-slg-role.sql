-- Add the slg user role on public.profiles.
-- Apply in the Supabase SQL editor. Safe to re-run.
--
-- If profiles_role_check already allows slg, this does nothing.
-- Other allowed values are kept. Production already allows
-- officer, roc, dispatch, slg, and admin, so this is a no-op there.
--
-- This file only extends profiles_role_check. It does not change RLS.
-- SLG charge-log and job-closure-log reads are in supabase-slg-log-access.sql.
-- SLG cannot add or edit users. That stays admin only.

do $$
declare
  def text;
  allowed text[];
begin
  select pg_get_constraintdef(c.oid)
    into def
  from pg_constraint c
  where c.conrelid = 'public.profiles'::regclass
    and c.conname = 'profiles_role_check'
    and c.contype = 'c';

  if def is null then
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('officer', 'roc', 'slg', 'admin'));
    return;
  end if;

  select coalesce(array_agg(distinct token), array[]::text[])
    into allowed
  from (
    select (regexp_matches(def, '''([a-z0-9_]+)''', 'g'))[1] as token
  ) tokens;

  if allowed @> array['slg']::text[] then
    return;
  end if;

  if allowed is null
    or cardinality(allowed) = 0
    or not (allowed && array['officer', 'roc', 'admin']::text[]) then
    raise exception 'profiles_role_check was not in the expected form: %', def;
  end if;

  allowed := allowed || array['slg'];

  alter table public.profiles drop constraint profiles_role_check;
  execute format(
    'alter table public.profiles add constraint profiles_role_check check (role in (%s))',
    (select string_agg(quote_literal(role_name), ', ' order by role_name) from unnest(allowed) as role_name)
  );
end $$;
