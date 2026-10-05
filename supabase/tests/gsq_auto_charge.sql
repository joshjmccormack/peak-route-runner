-- Local scratch test for the GSQ auto-100% charge.
-- Uses mocked fire_at values so it does not wait out the real delays.
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
        select coalesce(nullif(current_setting('pinassist.test_role', true), ''), 'officer')
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

-- Pretend the first migration was the older 7-hour map, then apply the follow-up.
delete from private.gsq_auto_charge_delays;
insert into private.gsq_auto_charge_delays (min_percent, max_percent, delay)
values
  (0, 20, interval '7 hours'),
  (80, 100, interval '2 hours');

\ir ../migrations/20261004103523_gsq_delay_bands_and_service_location.sql
\ir ../migrations/20261005103000_pending_gsq_auto_charge_eta.sql

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
  backfill_status text;
  cp_at timestamptz;
  pending_future integer;
  visible_eta integer;
  sample_fleet text;
  sample_vehicle text;
  sample_fire timestamptz;
  eta_matches boolean;
begin
  if exists (
    select 1
    from gsq_policy_before b
    where not exists (
      select 1
      from pg_policy p
      where p.polrelid = 'public.vehicle_charges'::regclass
        and p.polname = b.polname
        and p.polcmd::text = b.polcmd
        and pg_get_expr(p.polqual, p.polrelid) is not distinct from b.using_expr
        and pg_get_expr(p.polwithcheck, p.polrelid) is not distinct from b.check_expr
    )
  ) then
    raise exception 'GSQ test failed: an existing vehicle_charges policy changed';
  end if;
  perform pg_temp.expect(
    (select count(*) from pg_policy
      where polrelid = 'public.vehicle_charges'::regclass
        and polname = 'service location is roc slg admin') = 1,
    'SERVICE insert restriction is missing'
  );

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
    (select count(*) from private.gsq_auto_charge_delays) = 8,
    'delay map should be the eight GSQ bands'
  );
  perform pg_temp.expect(
    (select delay = interval '9 hours' from private.gsq_auto_charge_delays where min_percent = 0 and max_percent = 20)
    and (select delay = interval '8 hours' from private.gsq_auto_charge_delays where min_percent = 21 and max_percent = 30)
    and (select delay = interval '7 hours' from private.gsq_auto_charge_delays where min_percent = 31 and max_percent = 40)
    and (select delay = interval '6 hours' from private.gsq_auto_charge_delays where min_percent = 41 and max_percent = 50)
    and (select delay = interval '5 hours' from private.gsq_auto_charge_delays where min_percent = 51 and max_percent = 60)
    and (select delay = interval '4 hours' from private.gsq_auto_charge_delays where min_percent = 61 and max_percent = 70)
    and (select delay = interval '3 hours' from private.gsq_auto_charge_delays where min_percent = 71 and max_percent = 80)
    and (select delay = interval '2 hours' from private.gsq_auto_charge_delays where min_percent = 81 and max_percent = 100)
    and not exists (select 1 from private.gsq_auto_charge_delays where min_percent = 80 and max_percent = 100),
    'GSQ delay bands do not match 9h down to 2h'
  );
  perform pg_temp.expect(
    not has_function_privilege('authenticated', 'private.fire_due_gsq_auto_charges()', 'execute'),
    'authenticated must not execute the worker'
  );
  perform pg_temp.expect(
    not has_function_privilege('authenticated', 'private.backfill_met_cp115_gsq_20261004()', 'execute'),
    'authenticated must not run the CP115 backfill'
  );
  perform pg_temp.expect(
    not has_function_privilege('anon', 'private.backfill_met_cp115_gsq_20261004()', 'execute'),
    'anon must not run the CP115 backfill'
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
  perform pg_temp.expect(
    has_function_privilege('authenticated', 'public.pending_gsq_auto_charges()', 'execute'),
    'authenticated must execute the pending GSQ eta function'
  );
  perform pg_temp.expect(
    not has_function_privilege('anon', 'public.pending_gsq_auto_charges()', 'execute'),
    'anon must not execute the pending GSQ eta function'
  );
  perform pg_temp.expect(
    not has_function_privilege('public', 'public.pending_gsq_auto_charges()', 'execute'),
    'public must not execute the pending GSQ eta function'
  );
  perform pg_temp.expect(
    (select prosecdef and 'search_path=""' = any(proconfig)
     from pg_proc
     where oid = 'public.pending_gsq_auto_charges()'::regprocedure),
    'pending GSQ eta function must be security definer with an empty search_path'
  );
  perform pg_temp.expect(
    pg_get_function_result('public.pending_gsq_auto_charges()'::regprocedure)
      = 'TABLE(fleet text, vehicle text, fire_at timestamp with time zone)',
    'pending GSQ eta function exposes more than fleet, vehicle, and fire_at'
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
    (select fire_at = created_at + interval '9 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V1' and status = 'pending'),
    '10% should fire after 9 hours'
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
    (select source_charge_percent = 15 and fire_at = created_at + interval '9 hours'
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

  call pg_temp.log_charge('TACT', 'V4', 80, 'GSQ');
  call pg_temp.log_charge('TACT', 'V5', 0, 'GSQ');
  call pg_temp.log_charge('TACT', 'V6', 100, 'GSQ');
  call pg_temp.log_charge('TACT', 'V7', 20, 'GSQ');
  perform pg_temp.expect(
    (select fire_at = created_at + interval '3 hours' from private.gsq_auto_charge_jobs where vehicle = 'V4' and status = 'pending')
    and (select fire_at = created_at + interval '9 hours' from private.gsq_auto_charge_jobs where vehicle = 'V5' and status = 'pending')
    and (select fire_at = created_at + interval '2 hours' from private.gsq_auto_charge_jobs where vehicle = 'V6' and status = 'pending')
    and (select fire_at = created_at + interval '9 hours' from private.gsq_auto_charge_jobs where vehicle = 'V7' and status = 'pending'),
    'boundaries 80, 0, 100, and 20 queued the wrong delay'
  );

  declare
    sample record;
  begin
    for sample in
      select *
      from (values
        (21, 8), (30, 8), (31, 7), (40, 7), (41, 6), (50, 6),
        (51, 5), (60, 5), (61, 4), (70, 4), (71, 3), (81, 2)
      ) as band(pct, hours)
    loop
      call pg_temp.log_charge('TACT', 'P' || sample.pct, sample.pct, 'GSQ');
      perform pg_temp.expect(
        (select fire_at = created_at + make_interval(hours => sample.hours)
         from private.gsq_auto_charge_jobs
         where fleet = 'TACT' and vehicle = 'P' || sample.pct and status = 'pending'),
        format('GSQ %s%% did not wait %s hours', sample.pct, sample.hours)
      );
    end loop;
  end;

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
  set created_at = now() - interval '9 hours'
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
  perform pg_temp.expect(email = 'officer@example.com', 'auto row officer_email was not the source officer');
  perform pg_temp.expect(officer_name = 'Auto Update', 'auto row Who was not Auto Update');
  perform pg_temp.expect(
    (select j.officer_name = 'Alex O''Brien'
     from private.gsq_auto_charge_jobs j
     where j.fleet = 'TACT' and j.vehicle = 'V5' and j.status = 'fired'),
    'fired job did not keep the source officer name'
  );
  perform pg_temp.expect(fleet = 'TACT' and vehicle = 'V5', 'auto row fleet or vehicle changed');
  perform pg_temp.expect(auto_at > source_at + interval '8 hours', 'auto created_at was backdated to the original report');
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

  call pg_temp.log_charge('TACT', 'V10', 50, 'GSQ');
  perform pg_temp.expect(
    (select fire_at = created_at + interval '6 hours'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'V10' and status = 'pending'),
    '50% should fire after 6 hours'
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
  set delay = interval '9 hours'
  where min_percent = 0 and max_percent = 20;
  select fire_at, created_at, status into due_at, queued_at, job_status
  from private.gsq_auto_charge_jobs
  where fleet = 'TACT' and vehicle = 'V12';
  perform pg_temp.expect(
    job_status = 'pending' and due_at = queued_at + interval '5 hours',
    'editing the delay map moved a job that was already queued'
  );

  begin
    call pg_temp.log_charge('TACT', 'VS', null, 'SERVICE');
    raise exception 'GSQ test failed: an officer inserted SERVICE';
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    call pg_temp.log_charge('TACT', 'VS', null, 'OCT');
    raise exception 'GSQ test failed: OCT was saved without a charge percent';
  exception
    when check_violation then
      null;
  end;

  perform set_config('pinassist.test_role', 'admin', true);
  call pg_temp.log_charge('TACT', 'VS2', 12, 'GSQ');
  call pg_temp.log_charge('TACT', 'VS2', null, ' service ');
  select location, charge_percent into loc, pct
  from public.vehicle_charges
  where fleet = 'TACT' and vehicle = 'VS2' and location = 'SERVICE';
  perform pg_temp.expect(loc = 'SERVICE' and pct is null, 'SERVICE row did not store a null charge percent');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where fleet = 'TACT' and vehicle = 'VS2' and status = 'pending') = 0,
    'SERVICE should cancel the pending auto-100 and not queue another'
  );
  perform pg_temp.expect(
    (select status = 'cancelled' and cancel_reason = 'newer_charge'
     from private.gsq_auto_charge_jobs
     where fleet = 'TACT' and vehicle = 'VS2'
     order by created_at desc
     limit 1),
    'SERVICE did not cancel the GSQ job'
  );

  begin
    call pg_temp.log_charge('TACT', 'VS3', 40, 'SERVICE');
    raise exception 'GSQ test failed: SERVICE accepted a charge percent';
  exception
    when check_violation then
      null;
  end;

  perform set_config('pinassist.test_role', 'slg', true);
  call pg_temp.log_charge('MET', 'VS4', null, 'SERVICE');
  perform pg_temp.expect(
    (select charge_percent is null and location = 'SERVICE'
     from public.vehicle_charges
     where fleet = 'MET' and vehicle = 'VS4'),
    'SLG could not save SERVICE without a percent'
  );
  perform set_config('pinassist.test_role', 'roc', true);
  call pg_temp.log_charge('MET', 'VS5', null, 'SERVICE');
  perform pg_temp.expect(
    exists (
      select 1 from public.vehicle_charges
      where fleet = 'MET' and vehicle = 'VS5' and location = 'SERVICE' and charge_percent is null
    ),
    'ROC could not save SERVICE without a percent'
  );
  perform set_config('pinassist.test_role', 'officer', true);

  -- CP115 backfill. 21:24 Sydney on 4 Oct 2026 is 20:24 Brisbane, 10:24 UTC.
  cp_at := timestamp '2026-10-04 21:24:00' at time zone 'Australia/Sydney';
  perform pg_temp.expect(
    cp_at = timestamp '2026-10-04 20:24:00' at time zone 'Australia/Brisbane',
    'CP115 target instant is not 20:24 Brisbane'
  );

  alter table public.vehicle_charges disable trigger vehicle_charges_schedule_gsq_auto_charge;
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location, created_at
  ) values (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    'MET',
    'CP115',
    10,
    'GSQ',
    cp_at + interval '21 minutes'
  );
  alter table public.vehicle_charges enable trigger vehicle_charges_schedule_gsq_auto_charge;
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'no matching CP115 row', 'a charge outside the 20 minute window was backfilled');
  delete from public.vehicle_charges where vehicle = 'CP115';

  alter table public.vehicle_charges disable trigger vehicle_charges_schedule_gsq_auto_charge;
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location, created_at
  ) values
    (
      '11111111-1111-4111-8111-111111111111',
      'officer@example.com',
      'Alex O''Brien',
      'MET', 'CP115', 40, 'GSQ', cp_at - interval '5 minutes'
    ),
    (
      '11111111-1111-4111-8111-111111111111',
      'officer@example.com',
      'Alex O''Brien',
      'MET', 'CP115', 55, 'GSQ', cp_at + interval '5 minutes'
    );
  alter table public.vehicle_charges enable trigger vehicle_charges_schedule_gsq_auto_charge;
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'multiple CP115 rows in window', 'ambiguous CP115 rows were backfilled');
  perform pg_temp.expect(
    not exists (select 1 from private.gsq_auto_charge_jobs where vehicle = 'CP115'),
    'ambiguous CP115 backfill inserted a job'
  );
  delete from public.vehicle_charges where vehicle = 'CP115';

  alter table public.vehicle_charges disable trigger vehicle_charges_schedule_gsq_auto_charge;
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location, created_at
  ) values (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    'TACT',
    'CP115',
    10,
    'GSQ',
    cp_at
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    'MET',
    'CP115',
    50,
    'GSQ',
    cp_at
  );
  alter table public.vehicle_charges enable trigger vehicle_charges_schedule_gsq_auto_charge;
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'enqueued', 'MET CP115 at 21:24 Sydney was not enqueued');
  perform pg_temp.expect(
    (select count(*) = 1
      and bool_and(fleet = 'MET' and source_charge_percent = 50 and status = 'pending'
        and fire_at = cp_at + interval '6 hours'
        and created_at = cp_at
        and officer_name = 'Alex O''Brien'
        and user_id = '11111111-1111-4111-8111-111111111111'::uuid
        and officer_email = 'officer@example.com')
     from private.gsq_auto_charge_jobs
     where vehicle = 'CP115'),
    'CP115 job did not use the 50% band from the source created_at'
  );
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'job already covers CP115', 'second CP115 backfill was not a no-op');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where vehicle = 'CP115' and status = 'pending') = 1,
    'second CP115 backfill inserted another job'
  );

  update private.gsq_auto_charge_jobs
  set status = 'cancelled', cancel_reason = 'test', resolved_at = clock_timestamp()
  where vehicle = 'CP115' and status = 'pending';
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'enqueued', 'a cancelled CP115 job blocked a new queue');
  perform pg_temp.expect(
    (select count(*) from private.gsq_auto_charge_jobs where vehicle = 'CP115' and status = 'pending') = 1,
    're-queue after cancel did not leave one pending CP115 job'
  );

  update private.gsq_auto_charge_jobs
  set fire_at = now() - interval '1 minute'
  where vehicle = 'CP115' and status = 'pending';
  select jobs_fired, jobs_cancelled into fired, cancelled from private.fire_due_gsq_auto_charges();
  perform pg_temp.expect(fired = 1 and cancelled = 0, 'due CP115 backfill job did not fire');
  perform pg_temp.expect(
    (select c.officer_name = 'Auto Update'
      and c.officer_email = 'officer@example.com'
      and c.user_id = '11111111-1111-4111-8111-111111111111'::uuid
      and c.charge_percent = 100
      and c.location = 'GSQ'
      and c.fleet = 'MET'
     from public.vehicle_charges c
     where c.vehicle = 'CP115' and c.charge_percent = 100),
    'CP115 auto row Who was not Auto Update'
  );
  delete from public.vehicle_charges
  where vehicle = 'CP115' and charge_percent = 100;
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'job already covers CP115', 'fired CP115 job was queued again');

  delete from private.gsq_auto_charge_jobs where vehicle = 'CP115';
  alter table public.vehicle_charges disable trigger vehicle_charges_schedule_gsq_auto_charge;
  insert into public.vehicle_charges (
    user_id, officer_email, officer_name, fleet, vehicle, charge_percent, location, created_at
  ) values (
    '11111111-1111-4111-8111-111111111111',
    'officer@example.com',
    'Alex O''Brien',
    'MET',
    'CP115',
    80,
    'OCT',
    cp_at + interval '30 minutes'
  );
  alter table public.vehicle_charges enable trigger vehicle_charges_schedule_gsq_auto_charge;
  select private.backfill_met_cp115_gsq_20261004() into backfill_status;
  perform pg_temp.expect(backfill_status = 'newer charge exists', 'CP115 backfill ignored the newer charge');
  perform pg_temp.expect(
    not exists (select 1 from private.gsq_auto_charge_jobs where vehicle = 'CP115' and status = 'pending'),
    'CP115 backfill queued a job after a newer charge'
  );

  select count(*)::integer into pending_future
  from private.gsq_auto_charge_jobs
  where status = 'pending' and fire_at > now();
  perform pg_temp.expect(pending_future > 0, 'fixture should still have a future pending auto-100');

  select j.fleet, j.vehicle, j.fire_at
  into sample_fleet, sample_vehicle, sample_fire
  from private.gsq_auto_charge_jobs j
  where j.status = 'pending' and j.fire_at > now()
  order by j.fleet, j.vehicle
  limit 1;

  perform set_config('pinassist.test_role', 'officer', true);
  begin
    execute 'set role authenticated';
    select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
    execute 'reset role';
  exception
    when others then
      execute 'reset role';
      raise;
  end;
  perform pg_temp.expect(visible_eta = 0, 'an officer could see pending GSQ auto times');

  perform set_config('pinassist.test_role', 'roc', true);
  begin
    execute 'set role authenticated';
    select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
    select exists (
      select 1
      from public.pending_gsq_auto_charges() p
      where p.fleet = sample_fleet
        and p.vehicle = sample_vehicle
        and p.fire_at = sample_fire
    ) into eta_matches;
    execute 'reset role';
  exception
    when others then
      execute 'reset role';
      raise;
  end;
  perform pg_temp.expect(visible_eta = pending_future, 'ROC pending eta count does not match future pending jobs');
  perform pg_temp.expect(eta_matches, 'ROC eta fire_at does not match the queued job');

  perform set_config('pinassist.test_role', 'slg', true);
  select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
  perform pg_temp.expect(visible_eta = pending_future, 'SLG pending eta count does not match future pending jobs');

  perform set_config('pinassist.test_role', 'admin', true);
  select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
  perform pg_temp.expect(visible_eta = pending_future, 'admin pending eta count does not match future pending jobs');

  update private.gsq_auto_charge_jobs
  set fire_at = now() - interval '1 minute'
  where fleet = sample_fleet and vehicle = sample_vehicle and status = 'pending';
  select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
  perform pg_temp.expect(visible_eta = pending_future - 1, 'a due job was still listed as a pending eta');

  update private.gsq_auto_charge_jobs
  set fire_at = sample_fire,
      status = 'cancelled',
      cancel_reason = 'test',
      resolved_at = clock_timestamp()
  where fleet = sample_fleet and vehicle = sample_vehicle;
  select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
  perform pg_temp.expect(visible_eta = pending_future - 1, 'a cancelled job was still listed as a pending eta');

  perform set_config('pinassist.test_role', 'viewer', true);
  select count(*)::integer into visible_eta from public.pending_gsq_auto_charges();
  perform pg_temp.expect(visible_eta = 0, 'an unknown role could see pending GSQ auto times');

  begin
    execute 'set role anon';
    begin
      perform 1 from public.pending_gsq_auto_charges();
      raise exception 'GSQ test failed: anon read pending GSQ auto times';
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

  perform set_config('pinassist.test_role', 'officer', true);

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
