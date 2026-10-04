-- Local scratch test for the GSQ auto-100% charge.
-- Uses mocked fire_at values so it does not wait 2 or 7 hours.
-- Refuses to run when auth.users already has rows.
--
--   sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/gsq_auto_charge.sql
--
-- The whole fixture, including the cron job, rolls back.

\set ON_ERROR_STOP on

do $$
declare
  n bigint;
begin
  if to_regclass('auth.users') is not null then
    execute 'select count(*) from auth.users' into n;
    if n > 0 then
      raise exception 'Refusing to run the GSQ auto-charge test: auth.users already has rows. Use an empty local database.';
    end if;
  end if;
end $$;

select format('create role %I nologin', name)
from (values ('anon'), ('authenticated'), ('service_role')) as v(name)
where not exists (select 1 from pg_roles r where r.rolname = v.name)
\gexec

begin;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'officer@example.com');

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$
    $fn$;
  end if;
  if to_regprocedure('public.current_role()') is null then
    execute $fn$
      create function public.current_role()
      returns text
      language sql
      stable
      as $body$
        select 'officer'::text
      $body$
    $fn$;
  end if;
end $$;

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

drop policy if exists "roc and admin read charges" on public.vehicle_charges;
create policy "roc and admin read charges"
  on public.vehicle_charges
  for select
  to authenticated
  using (public.current_role() in ('roc', 'slg', 'admin'));

grant select, insert on public.vehicle_charges to authenticated;

create temp table gsq_policy_before as
select polname, polcmd::text as polcmd,
       pg_get_expr(polqual, polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as check_expr
from pg_policy
where polrelid = 'public.vehicle_charges'::regclass;

create function pg_temp.expect(ok boolean, message text)
returns void
language plpgsql
as $$
begin
  if not ok then
    raise exception 'GSQ test failed: %', message;
  end if;
end $$;

create procedure pg_temp.log_charge(
  p_fleet text,
  p_vehicle text,
  p_percent integer,
  p_location text
)
language plpgsql
as $$
begin
  execute 'set role authenticated';
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location
  ) values (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    p_fleet,
    p_vehicle,
    p_percent,
    p_location
  );
  execute 'reset role';
exception
  when others then
    execute 'reset role';
    raise;
end $$;

\ir ../migrations/20261004090820_gsq_auto_charge.sql
\ir ../migrations/20261004090820_gsq_auto_charge.sql

do $test$
#variable_conflict use_column
declare
  n integer;
  fired integer;
  cancelled integer;
  loc text;
  pct integer;
  uid uuid;
  email text;
  officer_name text;
  fleet text;
  vehicle text;
  auto_at timestamptz;
  source_at timestamptz;
  due_at timestamptz;
  queued_at timestamptz;
  job_status text;
  pending_before integer;
begin
  if (select count(*) from gsq_policy_before) <> (
    select count(*) from pg_policy where polrelid = 'public.vehicle_charges'::regclass
  ) then
    raise exception 'GSQ test failed: vehicle_charges policies changed';
  end if;
  if exists (
    select 1
    from gsq_policy_before b
    join pg_policy p on p.polrelid = 'public.vehicle_charges'::regclass and p.polname = b.polname
    where p.polcmd::text is distinct from b.polcmd
       or pg_get_expr(p.polqual, p.polrelid) is distinct from b.using_expr
       or pg_get_expr(p.polwithcheck, p.polrelid) is distinct from b.check_expr
  ) then
    raise exception 'GSQ test failed: a vehicle_charges policy expression changed';
  end if;

  perform pg_temp.expect(
    (select count(*) from cron.job where jobname = 'pinassist-gsq-auto-100') = 1,
    'expected one cron job after applying the migration twice'
  );
  perform pg_temp.expect(
    (select schedule = '* * * * *' and command like '%private.fire_due_gsq_auto_charges()%'
     from cron.job where jobname = 'pinassist-gsq-auto-100'),
    'cron job is not every minute calling the worker'
  );
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_delays) = 2,
    'delay map should stay two bands when re-applied'
  );
  perform pg_temp.expect(
    (select delay = interval '7 hours' from private.gsq_auto_charge_delays where min_percent = 0 and max_percent = 20),
    '0–20 should wait 7 hours'
  );
  perform pg_temp.expect(
    (select delay = interval '2 hours' from private.gsq_auto_charge_delays where min_percent = 80 and max_percent = 100),
    '80–100 should wait 2 hours'
  );
  perform pg_temp.expect(
    not has_function_privilege('authenticated', 'private.fire_due_gsq_auto_charges()', 'execute'),
    'authenticated must not execute the worker'
  );
  perform pg_temp.expect(
    not has_function_privilege('anon', 'private.fire_due_gsq_auto_charges()', 'execute'),
    'anon must not execute the worker'
  );
  perform pg_temp.expect(
    has_function_privilege('authenticated', 'private.schedule_gsq_auto_charge()', 'execute'),
    'authenticated must execute the schedule trigger'
  );
  perform pg_temp.expect(
    not has_function_privilege('anon', 'private.schedule_gsq_auto_charge()', 'execute'),
    'anon must not execute the schedule trigger'
  );
  perform pg_temp.expect(
    not has_function_privilege('authenticated', 'private.gsq_auto_charge_delay(integer)', 'execute'),
    'authenticated must not read the delay function'
  );
  perform pg_temp.expect(
    not has_table_privilege('authenticated', 'private.gsq_auto_charge_jobs', 'select'),
    'authenticated must not read pending jobs'
  );
  perform pg_temp.expect(
    not has_table_privilege('anon', 'private.gsq_auto_charge_delays', 'select'),
    'anon must not read the delay map'
  );

  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

  call pg_temp.log_charge('TACT', 'V1', 10, '  gSq ');
  select location into loc from public.vehicle_charges where fleet = 'TACT' and vehicle = 'V1' and charge_percent = 10;
  perform pg_temp.expect(loc = 'GSQ', 'typed gsq was not stored as GSQ');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V1' and status = 'pending') = 1,
    'low GSQ did not queue one job'
  );
  perform pg_temp.expect(
    (select fire_at = created_at + interval '7 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V1' and status = 'pending'),
    '10% should fire after 7 hours'
  );

  call pg_temp.log_charge('TACT', 'V1', 50, 'OCT');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V1' and status = 'pending') = 0,
    'OCT should cancel the pending auto-100 and not queue another'
  );
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V1' and status = 'cancelled' and cancel_reason = 'newer_charge') = 1,
    'cancelled job should record newer_charge'
  );

  call pg_temp.log_charge('TACT', 'V1', 90, 'GSQ');
  perform pg_temp.expect(
    (select fire_at = created_at + interval '2 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V1' and status = 'pending'),
    '90% should fire after 2 hours'
  );

  call pg_temp.log_charge('TACT', 'V1', 15, 'gsq');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V1' and status = 'pending') = 1,
    'a newer GSQ log should replace the pending job, not stack one'
  );
  perform pg_temp.expect(
    (select source_charge_percent = 15 and fire_at = created_at + interval '7 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V1' and status = 'pending'),
    'replacement job should follow the new 15% report'
  );

  call pg_temp.log_charge('MET', 'V1', 10, 'GSQ');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V1' and status = 'pending') = 1
    and (select count(*) from private.gsq_auto_charge_jobs where fleet = 'MET' and vehicle = 'V1' and status = 'pending') = 1,
    'the same vehicle in another fleet is a different queue'
  );

  call pg_temp.log_charge('TACT', 'V2', 21, 'GSQ');
  call pg_temp.log_charge('TACT', 'V3', 79, 'GSQ');
  perform pg_temp.expect(
    not exists (select 1 from private.gsq_auto_charge_jobs where vehicle in ('V2', 'V3')),
    '21% and 79% must not be scheduled'
  );

  call pg_temp.log_charge('TACT', 'V4', 80, 'GSQ');
  call pg_temp.log_charge('TACT', 'V5', 0, 'GSQ');
  call pg_temp.log_charge('TACT', 'V6', 100, 'GSQ');
  call pg_temp.log_charge('TACT', 'V7', 20, 'GSQ');
  perform pg_temp.expect(
    (select fire_at = created_at + interval '2 hours' from private.gsq_auto_charge_jobs where vehicle = 'V4' and status = 'pending')
    and (select fire_at = created_at + interval '7 hours' from private.gsq_auto_charge_jobs where vehicle = 'V5' and status = 'pending')
    and (select fire_at = created_at + interval '2 hours' from private.gsq_auto_charge_jobs where vehicle = 'V6' and status = 'pending')
    and (select fire_at = created_at + interval '7 hours' from private.gsq_auto_charge_jobs where vehicle = 'V7' and status = 'pending'),
    'boundaries 80, 0, 100, and 20 queued the wrong delay'
  );

  call pg_temp.log_charge('TACT', 'V8', 30, ' oct ');
  select location into loc from public.vehicle_charges where vehicle = 'V8';
  perform pg_temp.expect(loc = 'OCT', 'typed oct was not stored as OCT');
  perform pg_temp.expect(
    not exists (select 1 from private.gsq_auto_charge_jobs where vehicle = 'V8'),
    'OCT must not queue an auto-100'
  );

  begin
    call pg_temp.log_charge('TACT', 'V9', 10, 'yard');
    raise exception 'GSQ test failed: location yard was accepted';
  exception
    when check_violation then
      null;
  end;

  select count(*) into pending_before
  from private.gsq_auto_charge_jobs
  where status = 'pending';
  select jobs_fired, jobs_cancelled into fired, cancelled from private.fire_due_gsq_auto_charges();
  perform pg_temp.expect(fired = 0 and cancelled = 0, 'future jobs fired early');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where status = 'pending') = pending_before,
    'early fire changed pending jobs'
  );

  update public.vehicle_charges
  set created_at = now() - interval '7 hours'
  where fleet = 'TACT' and vehicle = 'V5' and charge_percent = 0;
  update private.gsq_auto_charge_jobs
  set fire_at = now() - interval '1 minute'
  where fleet = 'TACT' and vehicle = 'V5' and status = 'pending';

  select jobs_fired, jobs_cancelled into fired, cancelled from private.fire_due_gsq_auto_charges();
  perform pg_temp.expect(fired = 1 and cancelled = 0, 'due 0% job did not fire once');

  select c.charge_percent, c.location, c.user_id, c.officer_email, c.officer_name, c.fleet, c.vehicle, c.created_at
  into pct, loc, uid, email, officer_name, fleet, vehicle, auto_at
  from public.vehicle_charges c
  where c.fleet = 'TACT' and c.vehicle = 'V5' and c.charge_percent = 100;

  select s.created_at into source_at
  from public.vehicle_charges s
  where s.fleet = 'TACT' and s.vehicle = 'V5' and s.charge_percent = 0;

  perform pg_temp.expect(pct = 100 and loc = 'GSQ', 'auto row was not 100% at GSQ');
  perform pg_temp.expect(uid = '11111111-1111-4111-8111-111111111111'::uuid, 'auto row user_id was not the officer');
  perform pg_temp.expect(email = 'officer@example.com' and officer_name = 'Alex O''Brien', 'auto row officer fields were not copied');
  perform pg_temp.expect(fleet = 'TACT' and vehicle = 'V5', 'auto row fleet or vehicle changed');
  perform pg_temp.expect(auto_at > source_at + interval '6 hours', 'auto created_at was backdated to the original report');
  perform pg_temp.expect(auto_at >= now() - interval '1 minute', 'auto created_at was not the fire time');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V5' and status = 'pending') = 0,
    'firing a 100% row queued another follow-up'
  );
  perform pg_temp.expect(
    (select status = 'fired' and result_charge_id is not null
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V5'),
    'fired job was not marked fired'
  );

  select jobs_fired, jobs_cancelled into fired, cancelled from private.fire_due_gsq_auto_charges();
  perform pg_temp.expect(fired = 0 and cancelled = 0, 'running the worker again inserted another 100% row');
  perform pg_temp.expect(
    (select count(*) from public.vehicle_charges where fleet = 'TACT' and vehicle = 'V5' and charge_percent = 100) = 1,
    'more than one auto 100% row'
  );

  alter table public.vehicle_charges disable trigger vehicle_charges_schedule_gsq_auto_charge;
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location, created_at
  ) values (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    'TACT',
    'V4',
    40,
    'OCT',
    now() + interval '1 minute'
  );
  alter table public.vehicle_charges enable trigger vehicle_charges_schedule_gsq_auto_charge;
  update private.gsq_auto_charge_jobs
  set fire_at = now() - interval '1 minute'
  where fleet = 'TACT' and vehicle = 'V4' and status = 'pending';
  select jobs_fired, jobs_cancelled into fired, cancelled from private.fire_due_gsq_auto_charges();
  perform pg_temp.expect(fired = 0 and cancelled = 1, 'newer charge did not cancel a due job');
  perform pg_temp.expect(
    not exists (
      select 1 from public.vehicle_charges
      where fleet = 'TACT' and vehicle = 'V4' and charge_percent = 100
    ),
    'cancelled job still inserted 100%'
  );

  insert into private.gsq_auto_charge_delays (min_percent, max_percent, delay)
  values (21, 79, interval '4 hours');
  call pg_temp.log_charge('TACT', 'V10', 50, 'GSQ');
  perform pg_temp.expect(
    (select fire_at = created_at + interval '4 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V10' and status = 'pending'),
    'a newly added 21–79 band was not picked up'
  );
  delete from private.gsq_auto_charge_delays where min_percent = 21 and max_percent = 79;
  call pg_temp.log_charge('TACT', 'V10', 21, 'GSQ');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'V10' and status = 'pending') = 0,
    'removing the middle band should cancel and not reschedule'
  );
  call pg_temp.log_charge('TACT', 'V11', 50, 'GSQ');
  perform pg_temp.expect(
    not exists (select 1 from private.gsq_auto_charge_jobs where vehicle = 'V11'),
    '50% scheduled after the middle band was removed'
  );

  begin
    insert into private.gsq_auto_charge_delays (min_percent, max_percent, delay)
    values (10, 30, interval '3 hours');
    raise exception 'GSQ test failed: overlapping delay band was allowed';
  exception
    when others then
      if sqlerrm not like '%overlaps an existing band%' then
        raise;
      end if;
  end;

  update private.gsq_auto_charge_delays
  set delay = interval '5 hours'
  where min_percent = 0 and max_percent = 20;
  call pg_temp.log_charge('TACT', 'V12', 12, 'GSQ');
  select fire_at, created_at into due_at, queued_at
  from private.gsq_auto_charge_jobs
  where fleet = 'TACT' and vehicle = 'V12' and status = 'pending';
  perform pg_temp.expect(due_at = queued_at + interval '5 hours', 'edited delay was not used for a new report');
  update private.gsq_auto_charge_delays
  set delay = interval '7 hours'
  where min_percent = 0 and max_percent = 20;
  select fire_at, created_at, status into due_at, queued_at, job_status
  from private.gsq_auto_charge_jobs
  where fleet = 'TACT' and vehicle = 'V12';
  perform pg_temp.expect(
    job_status = 'pending' and due_at = queued_at + interval '5 hours',
    'editing the delay map moved a job that was already queued'
  );

  begin
    execute 'set role authenticated';
    begin
      perform private.fire_due_gsq_auto_charges();
      raise exception 'GSQ test failed: authenticated ran the worker';
    exception
      when insufficient_privilege then
        null;
    end;
    begin
      perform 1 from private.gsq_auto_charge_jobs;
      raise exception 'GSQ test failed: authenticated read pending jobs';
    exception
      when insufficient_privilege then
        null;
    end;
    perform set_config('request.jwt.claim.sub', '', true);
    begin
      insert into public.vehicle_charges (
        user_id, officer_email, fleet, vehicle, charge_percent, location
      ) values (
        '11111111-1111-4111-8111-111111111111',
        'officer@example.com',
        'TACT',
        'V13',
        10,
        'GSQ'
      );
      raise exception 'GSQ test failed: insert without the officer JWT succeeded';
    exception
      when insufficient_privilege then
        null;
    end;
    execute 'reset role';
  exception
    when others then
      execute 'reset role';
      raise;
  end;

  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
end
$test$;

rollback;

\echo GSQ auto-charge tests passed
