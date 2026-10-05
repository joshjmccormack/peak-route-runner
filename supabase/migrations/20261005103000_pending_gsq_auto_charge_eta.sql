-- PinAssist: let the charge log read when a GSQ auto-100 is still pending.
-- Apply on Parking Project (uklqyddpntttrcwaimji) after
-- 20261004103523_gsq_delay_bands_and_service_location.sql. Safe to re-run.
--
-- private.gsq_auto_charge_jobs stays closed. This function returns only
-- fleet, vehicle, and fire_at for jobs that are still pending and not yet due.
-- ROC, SLG, and Admin can call it. That is the same set of roles that can
-- read public.vehicle_charges. Officers may execute it and receive no rows.
-- anon cannot execute it.
-- A queued job keeps the fire_at it was given, so the client must not
-- recompute the delay from the current band map.

create or replace function public.pending_gsq_auto_charges()
returns table (
  fleet text,
  vehicle text,
  fire_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor text;
begin
  -- public.current_role() is the PinAssist profile role. The built-in
  -- current_role would be the function owner and would hide every row.
  actor := public.current_role();
  if actor is null or actor not in ('roc', 'slg', 'admin') then
    return;
  end if;

  return query
  select j.fleet, j.vehicle, j.fire_at
  from private.gsq_auto_charge_jobs j
  where j.status = 'pending'
    and j.fire_at > pg_catalog.now();
end;
$$;

comment on function public.pending_gsq_auto_charges() is
  'Pending GSQ auto-100 fire times for ROC, SLG, and Admin. Columns are fleet, vehicle, and fire_at. Does not expose private.gsq_auto_charge_jobs.';

revoke all on function public.pending_gsq_auto_charges() from public, anon, authenticated;
grant execute on function public.pending_gsq_auto_charges() to authenticated;
