LOCATION MAP SCREENSHOTS
========================

1. Open Google Maps and zoom in on the small street area for that stop.
2. Take a screenshot and crop it to just the map (keep the file small).
3. Save it in this photos/ folder as .jpg, .png, or .webp.
   Example: albert-st-mary-margaret.jpg
4. In routes.js, add a photo field on that location:

   "photo": "photos/albert-st-mary-margaret.jpg",

5. Redeploy / refresh route data. Tap the red pin on the location card to view it.

Keep filenames simple: letters, numbers, hyphens, underscores. Aim under ~200 KB.

If a location has no photo field (or the file is missing), the pin button still
appears and the popup says "No map screenshot yet."
