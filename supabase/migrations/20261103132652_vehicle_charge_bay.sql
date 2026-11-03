-- PinAssist: optional O'Connell Tce Level 1 bay on a vehicle charge.
-- Apply once on Parking Project (uklqyddpntttrcwaimji) after
-- supabase/migrations/20261031120000_show_longer_than_permitted.sql.
-- Safe to re-run.
--
-- Adds nullable public.vehicle_charges.bay. Does not change RLS, grants,
-- or the GSQ auto-charge insert. Auto-update rows leave bay null because
-- private.fire_due_gsq_auto_charges() lists its columns and does not set bay.
-- SERVICE rows may also leave it null. Officers pick a bay only for the
-- yellow Parking Compliance bays: 101–112 and 115–126.
-- 113, 114, 127–132, the pink bay, and the PWD bays are not stored.

alter table public.vehicle_charges
  add column if not exists bay text;

comment on column public.vehicle_charges.bay is
  'Optional Level 1 Podium bay at O''Connell Tce (41 OC). Null when no bay was chosen, including SERVICE and GSQ auto-update. Allowed values are 101–112 and 115–126.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'vehicle_charges_bay_check'
      and conrelid = 'public.vehicle_charges'::regclass
  ) then
    alter table public.vehicle_charges
      add constraint vehicle_charges_bay_check
      check (
        bay is null
        or bay in (
          '101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112',
          '115', '116', '117', '118', '119', '120', '121', '122', '123', '124', '125', '126'
        )
      );
  end if;
end $$;
