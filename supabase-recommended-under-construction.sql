-- PinAssist: per-route flag for the Recommended sort label.
-- Project: Parking Project (uklqyddpntttrcwaimji).
-- Apply once in the Supabase SQL editor. Safe to re-run.
--
-- recommended_under_construction starts true for every route. While it is true,
-- the Peak Routes dashboard labels the Recommended button "Under Construction".
-- Recommended sorting still works either way.
--
-- When a route's recommended stop order is finished, clear that route only.
-- Example:
--
--   update public.routes
--   set recommended_under_construction = false
--   where id = 'peak12-am';
--
-- Current route ids:
--   peak12-am   Peak 1 & 2 – Morning
--   peak12-pm   Peak 1 & 2 – Afternoon
--   peak3-am    Peak 3 – Morning
--   peak3-pm    Peak 3 – Afternoon
--   peak4-am    Peak 4 – Morning
--   peak4-pm    Peak 4 – Afternoon
--   peak5-am    Peak 5 – Morning
--   peak5-pm    Peak 5 – Afternoon
--   peak6-am    Peak 6 – Morning
--   peak6-pm    Peak 6 – Afternoon
--   peak7-am    Peak 7 – Morning
--   peak7-pm    Peak 7 – Afternoon

alter table public.routes
  add column if not exists recommended_under_construction boolean not null default true;

comment on column public.routes.recommended_under_construction is
  'When true, the Recommended sort button shows Under Construction. Set false when that route recommended order is finished. Recommended sorting is unchanged.';
