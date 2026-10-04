-- PinAssist: after a GSQ vehicle charge, log that same vehicle again at 100%.
-- Apply on Parking Project (uklqyddpntttrcwaimji) in the Supabase SQL editor.
-- Safe to re-run. Requires public.vehicle_charges (already live).
--
-- The tablet does not schedule this. An insert trigger queues a row in
-- private.gsq_auto_charge_jobs, and pg_cron inserts the 100% charge when
-- fire_at is reached. pg_cron runs as postgres, which bypasses RLS the same
-- way the service role does. The new row keeps the original officer's
-- user_id and officer_email. officer_name is the literal Auto Update, which
-- is what the charge log Who column shows. Officer insert/read policies are
-- not changed. No service role key and no Edge Function.

create schema if not exists private;

comment on schema private is
  'Not exposed in the Data API. Privileged PinAssist helpers live here.';

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Delay map. Every GSQ percent from 0 to 100 matches one band.
-- Bands must not overlap. Rows already queued keep their existing fire_at.
-- 0–20 is 9 hours, then one hour less each 10% band, down to 2 hours at 81–100.
-- A later migration replaces these rows if an older 7-hour map was already applied.
create table if not exists private.gsq_auto_charge_delays (
  min_percent integer not null check (min_percent between 0 and 100),
  max_percent integer not null check (max_percent between 0 and 100),
  delay interval not null check (delay > interval '0'),
  primary key (min_percent, max_percent),
  check (min_percent <= max_percent)
);

comment on table private.gsq_auto_charge_delays is
  'How long after a GSQ report to log 100% for that vehicle. 0–20 is 9 hours, stepping down to 2 hours at 81–100.';

create table if not exists private.gsq_auto_charge_jobs (
  id uuid primary key default gen_random_uuid(),
  source_charge_id uuid not null references public.vehicle_charges (id) on delete cascade,
  fleet text not null,
  vehicle text not null,
  user_id uuid not null references auth.users (id),
  officer_email text,
  officer_name text,
  source_charge_percent integer not null,
  fire_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'fired', 'cancelled')),
  cancel_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  result_charge_id uuid references public.vehicle_charges (id) on delete set null
);

comment on table private.gsq_auto_charge_jobs is
  'One pending 100% GSQ follow-up per fleet + vehicle. A newer charge cancels it.';

create unique index if not exists gsq_auto_charge_jobs_one_pending_per_vehicle
  on private.gsq_auto_charge_jobs (fleet, vehicle)
  where status = 'pending';

create index if not exists gsq_auto_charge_jobs_due_idx
  on private.gsq_auto_charge_jobs (fire_at)
  where status = 'pending';

create index if not exists vehicle_charges_fleet_vehicle_created_at_idx
  on public.vehicle_charges (fleet, vehicle, created_at);

alter table private.gsq_auto_charge_delays enable row level security;
alter table private.gsq_auto_charge_delays force row level security;
alter table private.gsq_auto_charge_jobs enable row level security;
alter table private.gsq_auto_charge_jobs force row level security;

revoke all on table private.gsq_auto_charge_delays from public, anon, authenticated;
revoke all on table private.gsq_auto_charge_jobs from public, anon, authenticated;

alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;

create or replace function private.assert_gsq_delay_bands_do_not_overlap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bands_overlap boolean;
begin
  if tg_op = 'UPDATE' then
    select exists (
      select 1
      from private.gsq_auto_charge_delays d
      where (d.min_percent, d.max_percent) is distinct from (old.min_percent, old.max_percent)
        and int4range(d.min_percent, d.max_percent, '[]')
            && int4range(new.min_percent, new.max_percent, '[]')
    ) into bands_overlap;
  else
    -- Same primary key is the row ON CONFLICT will skip on re-run, not a second band.
    select exists (
      select 1
      from private.gsq_auto_charge_delays d
      where (d.min_percent, d.max_percent) is distinct from (new.min_percent, new.max_percent)
        and int4range(d.min_percent, d.max_percent, '[]')
            && int4range(new.min_percent, new.max_percent, '[]')
    ) into bands_overlap;
  end if;
  if bands_overlap then
    raise exception
      'GSQ auto-charge delay band %–% overlaps an existing band',
      new.min_percent, new.max_percent;
  end if;
  return new;
end;
$$;

drop trigger if exists gsq_auto_charge_delays_no_overlap on private.gsq_auto_charge_delays;
create trigger gsq_auto_charge_delays_no_overlap
  before insert or update on private.gsq_auto_charge_delays
  for each row
  execute function private.assert_gsq_delay_bands_do_not_overlap();

insert into private.gsq_auto_charge_delays (min_percent, max_percent, delay)
values
  (0, 20, interval '9 hours'),
  (21, 30, interval '8 hours'),
  (31, 40, interval '7 hours'),
  (41, 50, interval '6 hours'),
  (51, 60, interval '5 hours'),
  (61, 70, interval '4 hours'),
  (71, 80, interval '3 hours'),
  (81, 100, interval '2 hours')
on conflict (min_percent, max_percent) do nothing;

create or replace function private.gsq_auto_charge_delay(p_percent integer)
returns interval
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n integer;
  found interval;
begin
  select count(*)::integer, min(d.delay)
  into n, found
  from private.gsq_auto_charge_delays d
  where p_percent between d.min_percent and d.max_percent;
  if n > 1 then
    raise exception 'overlapping GSQ auto-charge delay bands for percent %', p_percent;
  end if;
  return found;
end;
$$;

-- Officers type GSQ in any case. The charge check constraint only allows OCT and GSQ,
-- so fold "gsq" / " GSQ " onto the canonical value before that check runs.
create or replace function private.canonicalize_vehicle_charge_location()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  loc text;
begin
  if new.location is null then
    return new;
  end if;
  loc := upper(btrim(new.location));
  if loc in ('GSQ', 'OCT', 'SERVICE') then
    new.location := loc;
  end if;
  return new;
end;
$$;

create or replace function private.schedule_gsq_auto_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  delay interval;
begin
  -- The 100% row inserted by the cron worker must not cancel its own job
  -- and must not queue another follow-up (100% would otherwise wait 2 hours forever).
  if coalesce(current_setting('pinassist.skip_gsq_schedule', true), '') = '1' then
    return new;
  end if;

  -- Any newer charge for this fleet + vehicle replaces a pending auto-100.
  -- SERVICE and OCT cancel only. A GSQ report queues one new job from the delay map.
  update private.gsq_auto_charge_jobs
  set status = 'cancelled',
      cancel_reason = 'newer_charge',
      resolved_at = pg_catalog.now()
  where fleet = new.fleet
    and vehicle = new.vehicle
    and status = 'pending';

  if new.location is distinct from 'GSQ' or new.charge_percent is null then
    return new;
  end if;

  delay := private.gsq_auto_charge_delay(new.charge_percent);
  if delay is null then
    return new;
  end if;

  insert into private.gsq_auto_charge_jobs (
    source_charge_id,
    fleet,
    vehicle,
    user_id,
    officer_email,
    officer_name,
    source_charge_percent,
    fire_at
  ) values (
    new.id,
    new.fleet,
    new.vehicle,
    new.user_id,
    new.officer_email,
    new.officer_name,
    new.charge_percent,
    pg_catalog.now() + delay
  );

  return new;
end;
$$;

create or replace function private.fire_due_gsq_auto_charges()
returns table (jobs_fired integer, jobs_cancelled integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  job record;
  has_newer boolean;
  new_charge_id uuid;
  fired_count integer := 0;
  cancelled_count integer := 0;
  error_text text;
begin
  -- Transaction-local. Officer sessions never see this, so a real GSQ log
  -- of 100% still queues its own follow-up.
  perform set_config('pinassist.skip_gsq_schedule', '1', true);

  for job in
    select
      j.id,
      j.source_charge_id,
      j.fleet,
      j.vehicle,
      j.user_id,
      j.officer_email,
      j.officer_name,
      j.created_at
    from private.gsq_auto_charge_jobs j
    where j.status = 'pending'
      and j.fire_at <= pg_catalog.now()
    order by j.fire_at, j.created_at, j.id
    for update skip locked
  loop
    error_text := null;
    begin
      -- Backstop if a newer charge was inserted without running the trigger.
      select exists (
        select 1
        from public.vehicle_charges c
        where c.fleet = job.fleet
          and c.vehicle = job.vehicle
          and c.id <> job.source_charge_id
          and c.created_at > job.created_at
      ) into has_newer;

      if has_newer then
        update private.gsq_auto_charge_jobs
        set status = 'cancelled',
            cancel_reason = 'newer_charge',
            resolved_at = pg_catalog.clock_timestamp()
        where id = job.id
          and status = 'pending';
        cancelled_count := cancelled_count + 1;
        continue;
      end if;

      insert into public.vehicle_charges (
        user_id,
        officer_email,
        officer_name,
        fleet,
        vehicle,
        charge_percent,
        location,
        created_at
      ) values (
        job.user_id,
        job.officer_email,
        'Auto Update',
        job.fleet,
        job.vehicle,
        100,
        'GSQ',
        pg_catalog.clock_timestamp()
      )
      returning id into new_charge_id;

      update private.gsq_auto_charge_jobs
      set status = 'fired',
          resolved_at = pg_catalog.clock_timestamp(),
          result_charge_id = new_charge_id,
          last_error = null
      where id = job.id
        and status = 'pending';

      if not found then
        raise exception 'GSQ auto-charge job % was no longer pending', job.id;
      end if;

      fired_count := fired_count + 1;
    exception
      when others then
        error_text := sqlerrm;
        raise warning 'GSQ auto-charge job % failed: %', job.id, error_text;
    end;

    if error_text is not null then
      update private.gsq_auto_charge_jobs
      set last_error = error_text
      where id = job.id
        and status = 'pending';
    end if;
  end loop;

  return query select fired_count, cancelled_count;
end;
$$;

comment on function private.fire_due_gsq_auto_charges() is
  'Insert due 100% GSQ charges. Visible officer_name is Auto Update; user_id and officer_email stay the source officer. Called every minute by pg_cron. Skips vehicles that already have a newer charge.';

revoke all on function private.assert_gsq_delay_bands_do_not_overlap() from public;
revoke all on function private.gsq_auto_charge_delay(integer) from public;
revoke all on function private.canonicalize_vehicle_charge_location() from public;
revoke all on function private.schedule_gsq_auto_charge() from public;
revoke all on function private.fire_due_gsq_auto_charges() from public;

-- Officers need to execute the trigger functions. They cannot execute the worker.
grant execute on function private.canonicalize_vehicle_charge_location() to authenticated;
grant execute on function private.schedule_gsq_auto_charge() to authenticated;

drop trigger if exists vehicle_charges_canonicalize_location on public.vehicle_charges;
create trigger vehicle_charges_canonicalize_location
  before insert on public.vehicle_charges
  for each row
  execute function private.canonicalize_vehicle_charge_location();

drop trigger if exists vehicle_charges_schedule_gsq_auto_charge on public.vehicle_charges;
create trigger vehicle_charges_schedule_gsq_auto_charge
  after insert on public.vehicle_charges
  for each row
  execute function private.schedule_gsq_auto_charge();

-- pg_cron reads jobs from the database named in cron.database_name (postgres on Supabase).
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Same job name overwrites the schedule and command on re-run.
select cron.schedule(
  'pinassist-gsq-auto-100',
  '* * * * *',
  $$select private.fire_due_gsq_auto_charges();$$
);
