-- Admin user edits go through the update-user edge function, which checks
-- profiles.role = 'admin' and then writes with the service role.
-- This file does not add an update policy. It restores the column grant from
-- supabase-roles.sql so a signed-in user can change only their own display name.
-- Role, email, and officer code stay off the client. Listing other users still
-- depends on the existing select policy: own row, or admin via current_role().

revoke update on table public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
