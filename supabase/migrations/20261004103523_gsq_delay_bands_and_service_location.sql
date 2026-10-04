-- PinAssist follow-up for GSQ auto-100 and the SERVICE location.
-- Apply on Parking Project (uklqyddpntttrcwaimji) after
-- 20261004090820_gsq_auto_charge.sql. Safe to re-run.
--
-- Replaces the delay map, including databases that already stored
-- 0–20 as 7 hours and 80–100 as 2 hours.
-- SERVICE is a location only ROC, SLG, and Admin may insert.
-- A SERVICE row has no charge percent. It does not queue an auto-100.
-- Auto-100 rows store officer_name as Auto Update. user_id and officer_email
-- stay the officer who logged the source charge.
--
-- Delays are absolute intervals added to vehicle_charges.created_at
-- (timestamptz). They do not depend on the charge-log display zone.
-- The app shows those instants in Australia/Brisbane.
--
-- One backfill only: MET CP115, location GSQ, logged about 9:24pm on
-- 4 Oct 2026 as read on a Sydney device. That instant is 8:24pm Brisbane.
-- It is not 9:24pm Brisbane.

-- Exact GSQ schedule. Queued jobs keep the fire_at they already have.
delete from private.gsq_auto_charge_delays
where (min_percent, max_percent) not in (
  (0, 20),
  (21, 30),
  (31, 40),
  (41, 50),
  (51, 60),
  (61, 70),
  (71, 80),
  (81, 100)
);

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
on conflict (min_percent, max_percent) do update
  set delay = excluded.delay;

comment on table private.gsq_auto_charge_delays is
  'How long after a GSQ report to log 100% for that vehicle. 0–20 is 9 hours, stepping down to 2 hours at 81–100.';

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

revoke all on function private.canonicalize_vehicle_charge_location() from public;
grant execute on function private.canonicalize_vehicle_charge_location() to authenticated;

-- SERVICE stores no percent. OCT and GSQ still require 0–100.
alter table public.vehicle_charges
  alter column charge_percent drop not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.vehicle_charges'::regclass
      and con.contype = 'c'
      and (
        pg_get_constraintdef(con.oid) ilike '%location%'
        or pg_get_constraintdef(con.oid) ilike '%charge_percent%'
      )
  loop
    execute format(
      'alter table public.vehicle_charges drop constraint %I',
      constraint_name
    );
  end loop;
end $$;

alter table public.vehicle_charges
  drop constraint if exists vehicle_charges_location_charge_check;

alter table public.vehicle_charges
  add constraint vehicle_charges_location_charge_check
  check (
    (
      location = 'SERVICE'
      and charge_percent is null
    )
    or (
      location in ('OCT', 'GSQ')
      and charge_percent is not null
      and charge_percent between 0 and 100
    )
  );

comment on column public.vehicle_charges.charge_percent is
  '0–100 for OCT and GSQ. Null when location is SERVICE.';

comment on column public.vehicle_charges.location is
  'OCT, GSQ, or SERVICE. SERVICE is inserted only by ROC, SLG, and Admin.';

-- Does not replace the officer insert policy. This extra check blocks SERVICE
-- for everyone except ROC, SLG, and Admin.
drop policy if exists "service location is roc slg admin" on public.vehicle_charges;
create policy "service location is roc slg admin"
  on public.vehicle_charges
  as restrictive
  for insert
  to authenticated
  with check (
    upper(btrim(location)) is distinct from 'SERVICE'
    or public.current_role() in ('roc', 'slg', 'admin')
  );

-- Replaces the worker from 20261004090820 so an already-applied database
-- shows Auto Update in the charge log Who column.
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

revoke all on function private.fire_due_gsq_auto_charges() from public;

-- One existing live row. Josh read it as about 9:24pm on 4 Oct 2026 because
-- the charge log followed his Sydney device. Brisbane for that same instant
-- is 8:24pm. Match the timestamptz, within 20 minutes, and enqueue once.
-- fire_at is that created_at plus the new delay band. Re-running does nothing
-- when a newer charge exists or a pending/fired job already covers the row.
-- The worker writes officer_name 'Auto Update' when it inserts the 100% charge.
create or replace function private.backfill_met_cp115_gsq_20261004()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_at timestamptz := timestamp '2026-10-04 21:24:00' at time zone 'Australia/Sydney';
  match_count integer;
  src public.vehicle_charges%rowtype;
  delay interval;
begin
  select count(*)::integer into match_count
  from public.vehicle_charges c
  where upper(pg_catalog.btrim(c.fleet)) = 'MET'
    and upper(pg_catalog.btrim(c.vehicle)) = 'CP115'
    and upper(pg_catalog.btrim(c.location)) = 'GSQ'
    and c.created_at >= target_at - interval '20 minutes'
    and c.created_at < target_at + interval '20 minutes';

  if match_count = 0 then
    raise notice 'CP115 backfill: no MET GSQ CP115 charge within 20 minutes of 2026-10-04 21:24 Australia/Sydney (20:24 Australia/Brisbane).';
    return 'no matching CP115 row';
  end if;

  if match_count > 1 then
    raise notice 'CP115 backfill: % matching rows; not enqueueing.', match_count;
    return 'multiple CP115 rows in window';
  end if;

  select c.* into src
  from public.vehicle_charges c
  where upper(pg_catalog.btrim(c.fleet)) = 'MET'
    and upper(pg_catalog.btrim(c.vehicle)) = 'CP115'
    and upper(pg_catalog.btrim(c.location)) = 'GSQ'
    and c.created_at >= target_at - interval '20 minutes'
    and c.created_at < target_at + interval '20 minutes';

  if exists (
    select 1
    from public.vehicle_charges c
    where c.fleet = src.fleet
      and c.vehicle = src.vehicle
      and c.id <> src.id
      and c.created_at > src.created_at
  ) then
    raise notice 'CP115 backfill: a newer charge exists for % %; not enqueueing.', src.fleet, src.vehicle;
    return 'newer charge exists';
  end if;

  if exists (
    select 1
    from private.gsq_auto_charge_jobs j
    where j.source_charge_id = src.id
      and j.status in ('pending', 'fired')
  ) or exists (
    select 1
    from private.gsq_auto_charge_jobs j
    where j.fleet = src.fleet
      and j.vehicle = src.vehicle
      and j.status = 'pending'
  ) then
    raise notice 'CP115 backfill: a pending or fired auto job already covers this charge.';
    return 'job already covers CP115';
  end if;

  delay := private.gsq_auto_charge_delay(src.charge_percent);
  if delay is null then
    raise notice 'CP115 backfill: no delay band for charge percent %.', src.charge_percent;
    return 'no delay for percent';
  end if;

  insert into private.gsq_auto_charge_jobs (
    source_charge_id,
    fleet,
    vehicle,
    user_id,
    officer_email,
    officer_name,
    source_charge_percent,
    fire_at,
    created_at
  ) values (
    src.id,
    src.fleet,
    src.vehicle,
    src.user_id,
    src.officer_email,
    src.officer_name,
    src.charge_percent,
    src.created_at + delay,
    src.created_at
  );

  raise notice 'CP115 backfill: enqueued 100%% GSQ for % % from %, fire_at % (delay %). The inserted charge Who is Auto Update.',
    src.fleet, src.vehicle, src.created_at, src.created_at + delay, delay;
  return 'enqueued';
end;
$$;

comment on function private.backfill_met_cp115_gsq_20261004() is
  'One-time queue for MET CP115 GSQ logged about 21:24 Australia/Sydney on 4 Oct 2026 (20:24 Australia/Brisbane). fire_at is created_at plus the current delay band.';

revoke all on function private.backfill_met_cp115_gsq_20261004() from public;

select private.backfill_met_cp115_gsq_20261004();
