PinAssist
Current app version: v1.1
Live URL: https://pinassist.app
GitHub repository: joshjmccormack/peak-route-runner (will be renamed to joshjmccormack/PinAssist later)

PinAssist is the field app for peak routes, run maps, vehicle charges, and job closures. The site is a static PWA on GitHub Pages, served from the site root so it works at https://pinassist.app.

ROUTE DATA (SUPABASE)
---------------------
Route data lives only in Supabase. The old public routes.js file has been removed from the site.
After sign-in, PinAssist loads the route list from Supabase.
Project: Parking Project, ref uklqyddpntttrcwaimji (URL in js/supabase-config.js).

Tables:
- public.routes (id, name, group_name, period, sort_index)
- public.route_locations (id, route_id, "order", name, query, detail, detail_long, lat, lng, photo, sort_index)

Access is enforced with Row Level Security and the existing public.current_role() function:
- SELECT: any signed-in user (officer, ROC, or admin)
- INSERT, UPDATE, DELETE: admin only
- A request with no user JWT is denied. The anon role has no grant on these tables.

How admins edit routes from now on:
1. Apply supabase-routes.sql once, if the tables are not already there. That file creates the tables, policies, and a one-time seed of the original peak catalogue.
2. Edit rows in the Supabase Table Editor (public.routes and public.route_locations). group_name is the on-screen group. detail_long is the full restriction text the app uses for expiry (detailLong). "order" is the recommended sequence. lat and lng are the navigation pin; leave them empty to geocode from query.
3. Officers tap Refresh route data, or open the app again while online. The latest list is cached on the phone for offline use.
4. Do not add a public route file back to the site. A request for /routes.js should 404.

Photos stay as files under photos/. Set route_locations.photo to a path such as photos/albert-st.jpg, then deploy the image.

Older notes below that mention routes.js describe previous versions. That file is gone.

This version contains the Peak routes extracted from the supplied "Peak Enforcement" document:
- Peak 1 & 2 Morning / Afternoon
- Peak 3 Morning / Afternoon
- Peak 4 Morning / Afternoon
- Peak 5 Morning / Afternoon
- Peak 6 Morning / Afternoon
- Peak 7 Morning / Afternoon

HOW IT WORKS
1. Choose the Peak route and Morning/Afternoon.
2. Allow phone location permission.
3. On first use of a route, the app looks up each street location online and caches its coordinates on the phone.
4. It shows the nearest remaining location.
5. Navigate opens Google Maps.
6. Complete or Skip removes that stop from the remaining route and recalculates.
7. Progress is saved locally.

IMPORTANT
- Street names and enforcement details were transcribed from the supplied source document.
- The source mainly identifies streets/road segments, not exact GPS pins. The app therefore geocodes the street names on first use.
- Check the resulting navigation destination before operational use, especially for long streets or locations described as "between" two cross streets.
- For proper Android "Install app" / PWA behaviour and reliable geolocation, host these files on an HTTPS site.
- Online access is required for first-time geocoding, reverse address lookup and Google Maps navigation.


VERSION 3 CHANGES
-----------------
- Remaining locations are automatically sorted from closest to furthest once GPS is available.
- Every remaining location is tappable.
- Tapping a location makes it the selected destination even if it is not the closest.
- Navigate, Complete and Skip now apply to the selected destination.
- The nearest remaining location is still automatically selected by default.
- Completed and skipped locations move to the bottom of the list.
- GPS acquisition now watches for a better high-accuracy fix for up to about 15 seconds instead of accepting only the first location result.


VERSION 4 CHANGES
-----------------
- Completed locations now have a light green background and green status text.
- Skipped locations now have a light orange background and orange status text.
- Remaining locations stay white/neutral.
- Status labels now read Completed, Skipped and Remaining for faster visual scanning.


VERSION 5 CHANGES
-----------------
- Every route list item now shows its live distance from the phone.
- Distance appears at the bottom-right of each card as "x.x km away".
- The list remains sorted from closest to furthest.


VERSION 6 CHANGES
-----------------
- Added "Navigate selected" and "Navigate remaining route" buttons.
- Navigate remaining route sends the selected location first, then the next closest remaining locations to Google Maps.
- Up to 10 stops are sent to Google Maps at a time for reliability.
- Route/location data has been moved out of index.html into routes.js.

EDITING LOCATIONS LATER
-----------------------
Edit public.route_locations in Supabase (see ROUTE DATA at the top). Each stop has:
  id          = unique internal identifier (best left unchanged)
  name        = the label shown in PinAssist
  query       = the address/location text used for geocoding
  detail      = short text shown on the location card
  detail_long = full restriction text shown in the photo popup (used for expiry times)
  photo       = optional map screenshot path, e.g. photos/albert-st.jpg

When shortening card text, edit detail only. Leave detail_long as the full restriction
text so expiry still reads the times.

For a simple correction, edit name, query, detail and/or detail_long in the Supabase
table. Officers then tap Refresh route data, or reopen the app while online.

IMPORTANT: PinAssist caches geocoded coordinates in the phone browser. If you
change a query for a location that has already been resolved on that phone, clear
site data once so the app geocodes the corrected location again. A future version
can add an in-app "refresh location data" button if desired.


VERSION 7 CHANGES
-----------------
- Every location in routes.js now has editable "lat" and "lng" fields.
- The visible location name and detail stay completely separate from the navigation point.
- If lat/lng are set, the app uses those exact coordinates for:
  * nearest-to-furthest ordering
  * displayed distance
  * Navigate selected
  * Navigate remaining route
- If lat/lng are left as null, the app falls back to the existing query/geocoding behaviour.

HOW TO SET AN EXACT LOCATION
----------------------------
In Supabase, open public.route_locations, find the stop, and set lat and lng.
For example:

  lat = -27.469800
  lng = 153.025100

Do not put quotation marks around the coordinate numbers.

You do NOT need to change name or detail, so the location can continue to appear
in the app exactly as it does now while navigation uses your precise chosen pin.

Changing lat/lng does not require clearing the old geocoding cache. After saving
the row, reload the app online or tap Refresh route data.


VERSION 9 CHANGES
-----------------
- Normal single-route use remains one tap, exactly as before.
- Added an optional "Combine two routes" mode on the route selection page.
- In combine mode, select any two routes and tap "Start combined routes".
- The two routes are merged into one location list and sorted closest to furthest.
- Each combined-list item shows which original Peak route it belongs to.
- Navigation, distance, Complete and Skip all work across the combined list.
- Progress completed in a combined route is also saved against the original individual routes.
- This is intended to support short-staffing combinations such as Peak 6 + Peak 7.


VERSION 10 FIX
--------------
- Fixed a coordinate-handling bug introduced when editable lat/lng fields were added.
- Unset coordinates ("lat": null, "lng": null) were accidentally treated as 0,0,
  which made Brisbane locations appear roughly 15,000+ km away.
- Unset coordinates now correctly fall back to the normal geocoded street location.
- GPS status now says "Using best available location" if the phone cannot reach the
  preferred accuracy threshold before the acquisition timeout.


VERSION 11.0 CHANGES
--------------------
- Added automatic route-data updating.
- routes.js is fetched fresh from Netlify whenever the app opens and internet is available.
- Latest successful route data is saved locally for offline use.
- Added visible app version: PinAssist v11.0.
- Added visible "Route data updated" timestamp.
- Timestamp changes only after routes.js is successfully fetched.
- Added automatic service-worker update checks on launch.
- New service workers activate immediately and old app caches are removed.
- index.html and routes.js use network-first behaviour so normal updates should not require uninstall/reinstall.

ROUTE DATA UPDATE WORKFLOW
--------------------------
1. Edit public.routes or public.route_locations in Supabase (admin only).
2. The next time an installed PinAssist opens with internet access and a signed-in session, it loads the tables.
3. "Route data updated" shows the time of that successful load.
4. If offline, the app uses the last successfully downloaded route list from the phone.
5. There is no public routes file to upload.

APP UPDATE WORKFLOW
-------------------
Deploy the new app files to GitHub Pages. The live site is https://pinassist.app. On launch, PinAssist checks for a newer service worker and reloads once if needed.


VERSION 12.0 CHANGES
--------------------
- Added automatic time-based location expiry.
- Each route location now has an expireTime field in routes.js.
- expireTime is set 5 minutes before the latest actual restriction end time shown in the location detail.
  Example: 4pm–6pm becomes expireTime "17:55".
- At the expireTime, the location:
  * turns red,
  * shows an Expired status,
  * moves to the bottom of the location list,
  * is excluded from nearest-location selection,
  * is excluded from Navigate remaining route,
  * can no longer be selected as an active destination,
  * is excluded from the active remaining count.
- The app rechecks expiry every 30 seconds, so a location can expire while the app remains open.
- Time comparisons use Australia/Brisbane time.
- Locations with expireTime: null do not automatically expire.
- If a location detail contains more than one time range, the app data uses 5 minutes before the latest end time so the whole location is not hidden while one segment is still active.


VERSION 13.0 CHANGES
--------------------
- Expiry times are now calculated automatically from each location's detail text.
- Manual expireTime fields are no longer required in routes.js.
- PinAssist finds all readable time ranges in a location's detail.
- It uses the latest ending time and expires the location 5 minutes before that time.
- Examples:
  * 4pm–6pm -> expires 5:55pm
  * 4pm–7pm -> expires 6:55pm
  * 7am–9am -> expires 8:55am
- If a location has more than one time range, the latest ending time is used.
- If you change a time in detail_long in Supabase, every installed app loads the updated route data and calculates the new expiry automatically.
- If a location detail contains no readable time range, that location will not auto-expire.


VERSION 14.0 CHANGES
--------------------
- App markup, styles and logic are split into index.html, css/app.css and js/app.js.
- Fixed v13 expiry: times are now actually calculated from each location's detail text.
- Fixed route-data loading. Trailing commas in routes.js no longer prevent a successful fetch.
- Geocoding skips locations that already have exact lat/lng.
- Raw GPS coordinates are hidden unless you tap Show coordinates.
- Added Refresh route data, status colour chips, safer headers, and PWA cache updates.
- Version label is now v14.0.


SUPABASE ROUTE TABLES
---------------------
- Route lists load from public.routes and public.route_locations after sign-in.
- The public routes.js file has been removed. The app does not fetch it, and the service worker no longer caches it.
- Offline use still reads the last successful route list from localStorage.
- Macrossan Street on Peak 4 Afternoon had the same id as the Wharf Street stop (peak4-pm-10). It is now peak4-pm-10b so each stop can be stored and completed on its own. Both still share recommended order 10.
