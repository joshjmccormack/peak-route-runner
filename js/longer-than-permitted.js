// Saved spots and stay timers. End times live in localStorage so a reload
// or a backgrounded tab still shows the right countdown.
(function (root) {
  const STORAGE_KEY = "pinassist_ltp_v1";
  const TIME_ZONE = "Australia/Brisbane";
  const MAX_MINUTES = 1440;
  const GEO_DENIED = 1;
  const GEO_UNAVAILABLE = 2;
  const GEO_TIMEOUT = 3;
  // Same arrow as the Peak Routes directions button (NAV_ICON in app.js).
  const NAV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M8.4 18.45V12.1C8.4 8.9 10.75 7.25 14.15 7.25H16.9"/><path fill="currentColor" d="M15.55 4.6 21.45 7.45l-5.9 2.85z"/></svg>';
  const PRESETS = [
    { minutes: 5, label: "5m" },
    { minutes: 10, label: "10m" },
    { minutes: 15, label: "15m" },
    { minutes: 20, label: "20m" },
    { minutes: 25, label: "25m" },
    { minutes: 35, label: "35m" },
    { minutes: 70, label: "1h 10m" },
    { minutes: 130, label: "2h 10m" }
  ];
  // Same gap as geocodeMissing() in app.js. Nominatim asks for at most one request a second.
  const NOMINATIM_GAP_MS = 1100;

  let locations = [];
  let tickId = 0;
  let bound = false;
  let saving = false;
  let notifyAsked = false;
  let geocodeChain = Promise.resolve();
  const addressBusy = new Set();

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(id) {
    return document.getElementById(id);
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    if (hours > 0) return `${hours}:${mm}:${ss}`;
    return `${mm}:${ss}`;
  }

  function formatSavedAt(iso) {
    try {
      const when = new Date(iso);
      if (Number.isNaN(when.getTime())) return "time unavailable";
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: TIME_ZONE,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short"
      }).format(when);
    } catch (e) {
      return "time unavailable";
    }
  }

  function formatAccuracy(meters) {
    if (!Number.isFinite(meters)) return "accuracy unknown";
    if (meters >= 1000) return `±${(meters / 1000).toFixed(1)} km`;
    return `±${Math.round(meters)} m`;
  }

  function formatCoord(value) {
    return Number(value).toFixed(5);
  }

  function googleMapsUrl(lat, lng) {
    return `https://www.google.com/maps?q=${encodeURIComponent(`${Number(lat)},${Number(lng)}`)}`;
  }

  function geoErrorMessage(err) {
    const code = err && err.code;
    if (code === GEO_DENIED) return "Location permission was denied. Allow location for this site, then try again.";
    if (code === GEO_UNAVAILABLE) return "Your location is unavailable. Check that location is turned on, then try again.";
    if (code === GEO_TIMEOUT) return "Finding your location timed out. Try again.";
    return "Could not read your location. Try again.";
  }

  function validMinutes(minutes) {
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MINUTES;
  }

  function defaultLabel(list) {
    let max = 0;
    (list || []).forEach((loc) => {
      const match = /^Location (\d+)$/.exec(String(loc && loc.label || "").trim());
      if (!match) return;
      max = Math.max(max, Number(match[1]));
    });
    return `Location ${max + 1}`;
  }

  function looksLikeHouseNumber(value) {
    return /^(?:\d+[A-Za-z]?|\d+[A-Za-z]?(?:-\d+[A-Za-z]?)+)$/.test(String(value || "").trim());
  }

  function formatDisplayNameFallback(displayName) {
    if (!displayName) return "";
    const skip = /^(Australia|Queensland|QLD|\d{4})$/i;
    const parts = String(displayName).split(",").map((part) => part.trim()).filter((part) => part && !skip.test(part));
    if (!parts.length) return "";
    if (looksLikeHouseNumber(parts[0]) && parts[1]) {
      const street = `${parts[0]} ${parts[1]}`;
      return parts[2] ? `${street}, ${parts[2]}` : street;
    }
    const numbered = parts.findIndex(looksLikeHouseNumber);
    if (numbered >= 0 && parts[numbered + 1]) {
      const street = `${parts[numbered]} ${parts[numbered + 1]}`;
      const place = parts[numbered + 2] || parts[numbered - 1] || "";
      return place ? `${street}, ${place}` : street;
    }
    return parts.slice(0, 3).join(", ");
  }

  function shortStreetAddress(result) {
    if (!result || typeof result !== "object") return "";
    const address = result.address || {};
    const road = String(address.road || address.pedestrian || address.residential || address.footway || address.path || "").trim();
    let houseNumber = String(address.house_number || "").trim();
    if (!houseNumber && result.display_name) {
      const parts = String(result.display_name).split(",").map((part) => part.trim()).filter(Boolean);
      if (looksLikeHouseNumber(parts[0])) houseNumber = parts[0];
      else if (road) {
        const roadIdx = parts.findIndex((part) => part.toLowerCase() === road.toLowerCase());
        if (roadIdx > 0 && looksLikeHouseNumber(parts[roadIdx - 1])) houseNumber = parts[roadIdx - 1];
      }
    }
    const suburb = String(address.suburb || address.neighbourhood || address.city_district || address.city || address.town || "").trim();
    if (houseNumber && road && suburb) return `${houseNumber} ${road}, ${suburb}`;
    if (road && suburb) return `${road}, ${suburb}`;
    return formatDisplayNameFallback(result.display_name).replace(/\s+/g, " ").trim();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchNominatim(url) {
    if (typeof nominatimJson === "function") return nominatimJson(url);
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-AU"
      }
    });
    if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
    return res.json();
  }

  function isOnline() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  function normaliseLocations(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const next = [];
    value.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const lat = Number(item.lat);
      const lng = Number(item.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      const id = String(item.id || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const accuracy = Number(item.accuracy);
      const timerEnd = Number(item.timerEnd);
      const durationMinutes = Number(item.durationMinutes);
      const label = String(item.label || "").trim().slice(0, 80) || "Location";
      const entry = {
        id,
        label,
        lat,
        lng,
        accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
        savedAt: typeof item.savedAt === "string" ? item.savedAt : "",
        timerEnd: Number.isFinite(timerEnd) ? timerEnd : null,
        durationMinutes: Number.isInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : null,
        alerted: item.alerted === true
      };
      // Old saves have no addressStatus. Keep their label and do not geocode them again.
      if (item.addressStatus === "ready" || item.addressStatus === "pending") entry.addressStatus = item.addressStatus;
      next.push(entry);
    });
    return next;
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      locations = normaliseLocations(raw ? JSON.parse(raw) : []);
    } catch (e) {
      locations = [];
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
      return true;
    } catch (e) {
      setStatus("Could not save on this device.", "err");
      return false;
    }
  }

  function findLoc(id) {
    return locations.find((loc) => loc.id === id) || null;
  }

  function rowEl(id) {
    const list = el("ltpList");
    if (!list) return null;
    const rows = list.querySelectorAll(".ltp-row");
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-id") === id) return rows[i];
    }
    return null;
  }

  function setStatus(message, tone) {
    const status = el("ltpStatus");
    if (!status) return;
    status.classList.remove("ok", "err");
    if (!message) {
      status.textContent = "";
      status.classList.add("hidden");
      return;
    }
    status.textContent = message;
    status.classList.remove("hidden");
    if (tone) status.classList.add(tone);
  }

  function setRowMessage(id, message) {
    const row = rowEl(id);
    const node = row && row.querySelector(".ltp-row-msg");
    if (!node) return;
    if (!message) {
      node.textContent = "";
      node.classList.add("hidden");
      return;
    }
    node.textContent = message;
    node.classList.remove("hidden");
  }

  function hasActiveTimer() {
    return locations.some((loc) => Number.isFinite(loc.timerEnd));
  }

  function clockText(loc, now) {
    if (!Number.isFinite(loc.timerEnd)) return "";
    if (now >= loc.timerEnd) return `Overdue ${formatClock(now - loc.timerEnd)}`;
    return formatClock(loc.timerEnd - now);
  }

  function paintClocks(now) {
    if (typeof document !== "undefined" && document.hidden) return;
    locations.forEach((loc) => {
      const row = rowEl(loc.id);
      if (!row) return;
      const running = Number.isFinite(loc.timerEnd);
      const overdue = running && now >= loc.timerEnd;
      row.classList.toggle("ltp-overdue", overdue);
      const clock = row.querySelector(".ltp-clock");
      if (clock) {
        const text = clockText(loc, now);
        clock.textContent = text;
        clock.classList.toggle("hidden", !text);
      }
      row.classList.toggle("ltp-running", running);
      const cancel = row.querySelector("[data-action='cancel']");
      if (cancel) cancel.classList.toggle("hidden", !running);
    });
  }

  function notifyOverdue(loc) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate([200, 100, 200, 100, 320]);
      }
    } catch (e) { /* vibration is optional */ }
    try {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const note = new Notification("Longer Than Permitted", {
        body: `${loc.label} is overdue.`,
        tag: `ltp-${loc.id}`,
        lang: "en-AU"
      });
      note.onclick = () => {
        try { window.focus(); } catch (e) { /* ignore */ }
        note.close();
      };
    } catch (e) { /* notifications are optional */ }
  }

  function catchUpAlerts(now) {
    let changed = false;
    locations.forEach((loc) => {
      if (!Number.isFinite(loc.timerEnd) || now < loc.timerEnd || loc.alerted) return;
      loc.alerted = true;
      changed = true;
      notifyOverdue(loc);
    });
    if (changed) persist();
  }

  function stopTicker() {
    if (!tickId) return;
    clearInterval(tickId);
    tickId = 0;
  }

  function syncTicker() {
    if (!hasActiveTimer()) {
      stopTicker();
      return;
    }
    if (tickId) return;
    tickId = setInterval(onTick, 1000);
  }

  function onTick() {
    const now = Date.now();
    catchUpAlerts(now);
    if (typeof document !== "undefined" && document.hidden) return;
    paintClocks(now);
  }

  function onVisibility() {
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    catchUpAlerts(now);
    paintClocks(now);
    syncTicker();
  }

  function requestNotifyPermission() {
    if (notifyAsked) return;
    if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") return;
    if (Notification.permission !== "default") {
      notifyAsked = true;
      return;
    }
    notifyAsked = true;
    try {
      const pending = Notification.requestPermission();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (e) {
      try { Notification.requestPermission(() => {}); } catch (e2) { /* unsupported */ }
    }
  }

  function presetButtons() {
    return PRESETS.map((preset) =>
      `<button type="button" class="secondary ltp-preset" data-minutes="${preset.minutes}">${esc(preset.label)}</button>`
    ).join("");
  }

  function displayLabel(loc) {
    if (loc && addressBusy.has(loc.id)) return "Finding address…";
    return (loc && loc.label) || "Location";
  }

  function paintName(id) {
    const loc = findLoc(id);
    const row = rowEl(id);
    if (!loc || !row) return;
    const name = row.querySelector(".ltp-name");
    if (name) name.textContent = displayLabel(loc);
    const directions = row.querySelector("[data-action='directions']");
    if (directions) directions.setAttribute("aria-label", `Directions to ${loc.label}`);
  }

  function renderList() {
    const list = el("ltpList");
    if (!list) return;
    if (!locations.length) {
      list.innerHTML = `<p class="muted ltp-empty">No saved locations yet.</p>`;
      return;
    }
    const now = Date.now();
    list.innerHTML = locations.map((loc) => {
      const running = Number.isFinite(loc.timerEnd);
      const overdue = running && now >= loc.timerEnd;
      const clock = clockText(loc, now);
      return `<article class="ltp-row${running ? " ltp-running" : ""}${overdue ? " ltp-overdue" : ""}" data-id="${esc(loc.id)}">
        <div class="ltp-head">
          <p class="ltp-name">${esc(displayLabel(loc))}</p>
          <button type="button" class="danger small ltp-delete" data-action="delete">Delete</button>
        </div>
        <p class="muted ltp-meta">${esc(formatSavedAt(loc.savedAt))} · ${esc(formatCoord(loc.lat))}, ${esc(formatCoord(loc.lng))} · ${esc(formatAccuracy(loc.accuracy))}</p>
        <p class="ltp-clock${clock ? "" : " hidden"}">${esc(clock)}</p>
        <div class="ltp-setup">
          <div class="field-label">Timer</div>
          <div class="ltp-presets">${presetButtons()}</div>
          <p class="ltp-row-msg change-password-status err hidden"></p>
        </div>
        <div class="ltp-actions">
          <button type="button" class="secondary small ltp-cancel${running ? "" : " hidden"}" data-action="cancel">Cancel</button>
          <button type="button" class="locact locact-nav ltp-directions" data-action="directions" aria-label="Directions to ${esc(loc.label)}">${NAV_ICON}<span>Directions</span></button>
          <a class="secondary ltp-maps" data-action="maps" href="${esc(googleMapsUrl(loc.lat, loc.lng))}" target="_blank" rel="noopener noreferrer">Open in Maps</a>
        </div>
      </article>`;
    }).join("");
  }

  function startTimer(id, minutes) {
    const loc = findLoc(id);
    if (!loc || !validMinutes(minutes)) return false;
    requestNotifyPermission();
    loc.durationMinutes = minutes;
    loc.timerEnd = Date.now() + minutes * 60 * 1000;
    loc.alerted = false;
    persist();
    setRowMessage(id, "");
    paintClocks(Date.now());
    syncTicker();
    return true;
  }

  function cancelTimer(id) {
    const loc = findLoc(id);
    if (!loc) return;
    loc.timerEnd = null;
    loc.alerted = false;
    persist();
    setRowMessage(id, "");
    paintClocks(Date.now());
    syncTicker();
  }

  function ensureFallbackLabel(loc) {
    const label = String(loc.label || "").trim();
    if (/^Location \d+$/.test(label)) return;
    if (label && label !== "Location" && label !== "Finding address…") return;
    loc.label = defaultLabel(locations.filter((item) => item.id !== loc.id));
  }

  function deleteLocation(id) {
    const loc = findLoc(id);
    if (!loc) return;
    const name = displayLabel(loc);
    if (typeof window.confirm === "function" && !window.confirm(`Delete ${name}?`)) return;
    addressBusy.delete(id);
    locations = locations.filter((item) => item.id !== id);
    persist();
    renderList();
    syncTicker();
  }

  async function lookupAddress(id) {
    const loc = findLoc(id);
    if (!loc || loc.addressStatus === "ready") return false;
    if (!isOnline()) return false;
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(loc.lat)}&lon=${encodeURIComponent(loc.lng)}&zoom=18&addressdetails=1`;
    try {
      const data = await fetchNominatim(url);
      const still = findLoc(id);
      if (!still) return true;
      const name = shortStreetAddress(data).replace(/\s+/g, " ").trim().slice(0, 80);
      if (name) {
        still.label = name;
        still.addressStatus = "ready";
      } else {
        still.addressStatus = "pending";
        ensureFallbackLabel(still);
      }
      persist();
    } catch (e) {
      const still = findLoc(id);
      if (!still) return true;
      still.addressStatus = "pending";
      ensureFallbackLabel(still);
      persist();
    }
    return true;
  }

  function scheduleAddressLookup(id) {
    const loc = findLoc(id);
    if (!loc || loc.addressStatus === "ready" || addressBusy.has(id)) return;
    if (!isOnline()) return;
    addressBusy.add(id);
    paintName(id);
    geocodeChain = geocodeChain.then(async () => {
      let called = false;
      try {
        called = await lookupAddress(id);
      } catch (e) {
        called = true;
      } finally {
        addressBusy.delete(id);
        paintName(id);
        if (called) await delay(NOMINATIM_GAP_MS);
      }
    });
  }

  function retryPendingAddresses() {
    if (!isOnline()) return;
    locations.forEach((loc) => {
      if (loc.addressStatus === "pending") scheduleAddressLookup(loc.id);
    });
  }

  function openDirections(loc) {
    if (!loc) return;
    // Peak Routes directions: navigateTo sets location.href to the Google Maps
    // driving-directions URL. Omitting origin uses the device's current position.
    if (typeof navigateTo === "function") {
      navigateTo(loc);
      return;
    }
    const dest = `${Number(loc.lat)},${Number(loc.lng)}`;
    location.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
  }

  function openMaps(loc, href) {
    const url = href || (loc ? googleMapsUrl(loc.lat, loc.lng) : "");
    if (!url) return;
    if (typeof openInGoogleMapsApp === "function") {
      openInGoogleMapsApp(url);
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function onListClick(event) {
    const list = el("ltpList");
    const row = event.target.closest(".ltp-row");
    if (!list || !row || !list.contains(row)) return;
    const id = row.getAttribute("data-id");
    const preset = event.target.closest("[data-minutes]");
    if (preset && row.contains(preset)) {
      startTimer(id, Number(preset.getAttribute("data-minutes")));
      return;
    }
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !row.contains(actionEl)) return;
    const action = actionEl.getAttribute("data-action");
    if (action === "cancel") {
      cancelTimer(id);
      return;
    }
    if (action === "delete") {
      deleteLocation(id);
      return;
    }
    if (action === "directions") {
      openDirections(findLoc(id));
      return;
    }
    if (action === "maps") {
      event.preventDefault();
      openMaps(findLoc(id), actionEl.getAttribute("href"));
    }
  }

  function bind() {
    if (bound || typeof document === "undefined") return;
    bound = true;
    const saveBtn = el("ltpSaveLocation");
    if (saveBtn) saveBtn.addEventListener("click", saveMyLocation);
    const list = el("ltpList");
    if (list) list.addEventListener("click", onListClick);
    document.addEventListener("visibilitychange", onVisibility);
  }

  function saveMyLocation() {
    if (saving) return;
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
      setStatus("This browser cannot read your location.", "err");
      return;
    }
    const button = el("ltpSaveLocation");
    saving = true;
    if (button) button.disabled = true;
    setStatus("Finding your location…");
    try {
      navigator.geolocation.getCurrentPosition((position) => {
        saving = false;
        if (button) button.disabled = false;
        const coords = position && position.coords;
        const lat = coords && Number(coords.latitude);
        const lng = coords && Number(coords.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          setStatus("Could not read your location. Try again.", "err");
          return;
        }
        const accuracy = coords && Number(coords.accuracy);
        const loc = {
          id: `ltp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          label: defaultLabel(locations),
          addressStatus: "pending",
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
          savedAt: new Date().toISOString(),
          timerEnd: null,
          durationMinutes: null,
          alerted: false
        };
        locations.unshift(loc);
        persist();
        scheduleAddressLookup(loc.id);
        renderList();
        setStatus("Location saved.", "ok");
        const row = rowEl(loc.id);
        if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
      }, (err) => {
        saving = false;
        if (button) button.disabled = false;
        setStatus(geoErrorMessage(err), "err");
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    } catch (e) {
      saving = false;
      if (button) button.disabled = false;
      setStatus("Could not read your location. Try again.", "err");
    }
  }

  function open() {
    bind();
    loadFromStorage();
    renderList();
    const now = Date.now();
    catchUpAlerts(now);
    paintClocks(now);
    syncTicker();
    retryPendingAddresses();
  }

  function boot() {
    bind();
    loadFromStorage();
    catchUpAlerts(Date.now());
    syncTicker();
  }

  const api = {
    open,
    formatClock,
    formatSavedAt,
    geoErrorMessage,
    defaultLabel,
    normaliseLocations,
    googleMapsUrl,
    validMinutes,
    clockText,
    shortStreetAddress,
    presets: PRESETS
  };
  root.PinLongerThanPermitted = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") boot();
})(typeof window !== "undefined" ? window : globalThis);
