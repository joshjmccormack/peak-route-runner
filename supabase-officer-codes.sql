-- Nullable text. No check constraint.
-- PinAssist requires a code for officer, slg, and admin.
-- ROC may leave it blank. The create-user and update-user functions store that blank as null.
alter table public.profiles
  add column if not exists officer_code text;
