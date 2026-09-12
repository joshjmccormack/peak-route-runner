const APP_VERSION = "v14.0";

let ROUTES = [];
let currentId = localStorage.getItem("peak_current") || null;
let pos = null;
let nearest = null;
let selected = null;
let watchId = null;
let combineMode = false;
let combineSelection = [];
const geocache = JSON.parse(localStorage.getItem("peak_geocache") || "{}");

const ROUTE_DATA_CACHE_KEY = "peak_routes_cache_v11";
const ROUTE_DATA_UPDATED_KEY = "peak_routes_updated_v11";

function formatLocalTimestamp(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-AU", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(d);
  } catch (e) {
    return iso;
  }
}

function setRouteDataStatus(text, cls = "") {
  const el = document.getElementById("routeDataStatus");
  if (!el) return;
  el.textContent = text;
  el.className = cls;
}

function setRouteDataUpdated(iso) {
  const el = document.getElementById("routeDataUpdated");
  if (!el) return;
  el.textContent = iso ? `Route data updated: ${formatLocalTimestamp(iso)}` : "Route data updated: unavailable";
}

function stripTrailingCommas(text) {
  let prev;
  let out = text;
  do {
    prev = out;
    out = out.replace(/,(\s*[}\]])/g, "$1");
  } while (out !== prev);
  return out;
}

function parseRoutesJs(text) {
  const m = text.match(/const\s+ROUTES\s*=\s*(\[[\s\S]*\]);?\s*$/);
  if (!m) throw new Error("Invalid routes.js format");
  return JSON.parse(stripTrailingCommas(m[1]));
}

function clockToMinutes(hour, minute, mer) {
  let h = Number(hour);
  const min = Number(minute || 0);
  const ampm = String(mer).toLowerCase();
  if (ampm === "am") {
    if (h === 12) h = 0;
  } else if (ampm === "pm") {
    if (h !== 12) h += 12;
  }
  return h * 60 + min;
}

function minutesToClock(total) {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function expireTimeFromDetail(detail) {
  const text = String(detail || "");
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[–—\-]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
  let latestEnd = null;
  let match;
  while ((match = re.exec(text))) {
    const end = clockToMinutes(match[4], match[5], match[6]);
    if (latestEnd === null || end > latestEnd) latestEnd = end;
  }
  if (latestEnd === null) return null;
  return minutesToClock(latestEnd - 5);
}

function applyDerivedExpiry(routes) {
  routes.forEach((routeItem) => {
    (routeItem.locations || []).forEach((loc) => {
      const derived = expireTimeFromDetail(loc.detail);
      if (derived) loc.expireTime = derived;
    });
  });
}

async function loadLatestRoutes() {
  const cached = localStorage.getItem(ROUTE_DATA_CACHE_KEY);
  const cachedUpdated = localStorage.getItem(ROUTE_DATA_UPDATED_KEY);
  if (cached) {
    try {
      ROUTES = JSON.parse(cached);
      applyDerivedExpiry(ROUTES);
      setRouteDataUpdated(cachedUpdated);
    } catch (e) { /* ignore broken cache */ }
  }
  try {
    const res = await fetch(`./routes.js?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const fresh = parseRoutesJs(text);
    if (!Array.isArray(fresh) || !fresh.length) throw new Error("No route data");
    applyDerivedExpiry(fresh);
    ROUTES = fresh;
    const now = new Date().toISOString();
    localStorage.setItem(ROUTE_DATA_CACHE_KEY, JSON.stringify(fresh));
    localStorage.setItem(ROUTE_DATA_UPDATED_KEY, now);
    setRouteDataUpdated(now);
    setRouteDataStatus("Latest route data loaded", "updateok");
    return true;
  } catch (e) {
    if (ROUTES.length) {
      setRouteDataStatus("Offline / using saved route data", "updatewarn");
      return false;
    }
    setRouteDataUpdated(null);
    setRouteDataStatus("Could not load route data", "updatewarn");
    throw e;
  }
}

function progKey(id) { return "peak_prog_" + id; }

function rawProgress(id) {
  try { return JSON.parse(localStorage.getItem(progKey(id))) || {}; }
  catch (e) { return {}; }
}

function progress(id) {
  if (!id || !id.includes("+")) return rawProgress(id);
  const out = {};
  id.split("+").forEach((rid) => {
    const rp = rawProgress(rid);
    Object.entries(rp).forEach(([lid, state]) => { out[`${rid}__${lid}`] = state; });
  });
  return out;
}

function saveProgress(id, p) {
  if (!id.includes("+")) {
    localStorage.setItem(progKey(id), JSON.stringify(p));
    return;
  }
  id.split("+").forEach((rid) => {
    const rp = rawProgress(rid);
    const prefix = rid + "__";
    Object.entries(p).forEach(([key, state]) => {
      if (key.startsWith(prefix)) rp[key.slice(prefix.length)] = state;
    });
    localStorage.setItem(progKey(rid), JSON.stringify(rp));
  });
}

function route() {
  if (!currentId) return null;
  const ids = currentId.split("+");
  const chosen = ids.map((id) => ROUTES.find((r) => r.id === id)).filter(Boolean);
  if (!chosen.length) return null;
  if (chosen.length === 1) return chosen[0];
  return {
    id: ids.join("+"),
    name: chosen.map((r) => r.name).join(" + "),
    locations: chosen.flatMap((r) => r.locations.map((l) => ({
      ...l,
      originalId: l.id,
      sourceRouteId: r.id,
      sourceRouteName: r.name,
      id: `${r.id}__${l.id}`
    })))
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}

function showSelect() {
  selected = null;
  nearest = null;
  currentId = null;
  combineMode = false;
  combineSelection = [];
  localStorage.removeItem("peak_current");
  document.getElementById("select").classList.remove("hidden");
  document.getElementById("dash").classList.add("hidden");
  updateCombineUI();
  renderRoutes();
}

function renderRoutes() {
  const host = document.getElementById("routeGroups");
  host.innerHTML = "";
  [...new Set(ROUTES.map((r) => r.group))].forEach((g) => {
    const title = document.createElement("div");
    title.className = "group";
    title.textContent = g;
    host.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "routegrid";
    ROUTES.filter((r) => r.group === g).forEach((r) => {
      const p = progress(r.id);
      const expired = r.locations.filter((l) => !p[l.id] && isExpired(l)).length;
      const remain = r.locations.filter((l) => !p[l.id] && !isExpired(l)).length;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "routebtn";
      const chosen = combineSelection.includes(r.id);
      if (chosen) b.classList.add("routechosen");
      b.setAttribute("aria-pressed", combineMode ? String(chosen) : "false");
      b.innerHTML = `${combineMode ? `<div class="routecheck">${chosen ? "✓" : ""}</div>` : ""}<strong>${esc(r.period)}</strong><span>${remain} active${expired ? ` · ${expired} expired` : ""} · ${r.locations.length} total</span>`;
      b.onclick = () => {
        if (!combineMode) { openRoute(r.id); return; }
        const i = combineSelection.indexOf(r.id);
        if (i >= 0) combineSelection.splice(i, 1);
        else if (combineSelection.length < 2) combineSelection.push(r.id);
        else { combineSelection.shift(); combineSelection.push(r.id); }
        renderRoutes();
        updateCombineUI();
      };
      grid.appendChild(b);
    });
    host.appendChild(grid);
  });
}

function toggleCombineMode() {
  combineMode = !combineMode;
  combineSelection = [];
  updateCombineUI();
  renderRoutes();
}

function updateCombineUI() {
  const mode = document.getElementById("combineMode");
  const hint = document.getElementById("combineHint");
  const start = document.getElementById("startCombined");
  if (!mode) return;
  mode.textContent = combineMode ? "Cancel combine" : "Combine two routes";
  hint.classList.toggle("hidden", !combineMode);
  start.classList.toggle("hidden", !combineMode);
  start.disabled = combineSelection.length !== 2;
  if (combineMode) {
    start.textContent = combineSelection.length === 2
      ? "Start combined routes"
      : `Select ${2 - combineSelection.length} more route${combineSelection.length === 1 ? "" : "s"}`;
  }
}

function startCombinedRoutes() {
  if (combineSelection.length !== 2) return;
  openRoute(combineSelection.join("+"));
}

function openRoute(id) {
  selected = null;
  nearest = null;
  currentId = id;
  localStorage.setItem("peak_current", id);
  document.getElementById("select").classList.add("hidden");
  document.getElementById("dash").classList.remove("hidden");
  renderDash();
  findLocation();
  geocodeMissing();
}

function renderDash() {
  const r = route();
  if (!r) return showSelect();
  const p = progress(r.id);
  const done = Object.values(p).filter((x) => x === "complete").length;
  const skipped = Object.values(p).filter((x) => x === "skipped").length;
  const expired = r.locations.filter((l) => !p[l.id] && isExpired(l)).length;
  const active = r.locations.filter((l) => !p[l.id] && !isExpired(l)).length;
  document.getElementById("routeTitle").textContent = r.name;
  document.getElementById("remainPill").textContent = `${active} active`;
  document.getElementById("donePill").textContent = `${done} complete`;
  document.getElementById("skipPill").textContent = `${skipped} skipped`;
  document.getElementById("expiredPill").textContent = `${expired} expired`;
  calcNearest();
  renderLocationList();
}

function hasExactCoords(l) {
  return l.lat !== null && l.lng !== null &&
    l.lat !== "" && l.lng !== "" &&
    Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng));
}

function coordsFor(l) {
  if (hasExactCoords(l)) return { lat: Number(l.lat), lng: Number(l.lng), source: "exact" };
  const g = geocache[l.query];
  return g ? { lat: Number(g.lat), lng: Number(g.lng), source: "geocoded" } : null;
}

function distanceFor(l) {
  if (!pos) return null;
  const g = coordsFor(l);
  if (!g) return null;
  return hav(pos.lat, pos.lng, g.lat, g.lng);
}

function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return "";
  return `${(m / 1000).toFixed(1)} km`;
}

function brisbaneMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
}

function expiryMinutes(l) {
  if (!l || !l.expireTime || !/^\d{2}:\d{2}$/.test(l.expireTime)) return null;
  const [h, m] = l.expireTime.split(":").map(Number);
  return h * 60 + m;
}

function isExpired(l) {
  const cut = expiryMinutes(l);
  return cut !== null && brisbaneMinutesNow() >= cut;
}

function formatClock24(t) {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return "";
  const [hh, mm] = t.split(":").map(Number);
  const suffix = hh >= 12 ? "pm" : "am";
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

function renderLocationList() {
  const r = route();
  if (!r) return;
  const p = progress(r.id);
  const host = document.getElementById("list");
  host.innerHTML = "";
  const rows = r.locations.map((l, idx) => {
    const saved = p[l.id] || "remaining";
    const status = (saved === "remaining" && isExpired(l)) ? "expired" : saved;
    return { l, idx, distance: distanceFor(l), status };
  });
  rows.sort((a, b) => {
    const rank = (s) => s === "remaining" ? 0 : (s === "expired" ? 2 : 1);
    const ar = rank(a.status);
    const br = rank(b.status);
    if (ar !== br) return ar - br;
    if (a.status !== "remaining") return a.idx - b.idx;
    if (a.distance == null && b.distance == null) return a.idx - b.idx;
    if (a.distance == null) return 1;
    if (b.distance == null) return -1;
    return a.distance - b.distance;
  });
  rows.forEach(({ l, distance, status }) => {
    const d = document.createElement("div");
    d.className = "locrow";
    d.setAttribute("role", status === "remaining" ? "button" : "listitem");
    if (status === "complete") d.classList.add("completed");
    else if (status === "skipped") d.classList.add("skipped");
    else if (status === "expired") d.classList.add("expired");
    else d.classList.add("remaining");
    if (selected && selected.id === l.id && status === "remaining") d.classList.add("selected");
    const distanceText = status === "remaining" && distance != null ? formatDistance(distance) : "";
    const stateText = status === "complete" ? "✓ Completed"
      : status === "skipped" ? "↷ Skipped"
        : status === "expired" ? `⏱ Expired${l.expireTime ? ` at ${formatClock24(l.expireTime)}` : ""}`
          : "Remaining";
    const hint = status === "remaining"
      ? (selected && selected.id === l.id ? "Selected destination" : "Tap to select this location")
      : "";
    d.innerHTML = `<div class="rowtop"><strong>${esc(l.name)}</strong><div class="muted">${esc(l.detail)}</div>${l.sourceRouteName ? `<div class="muted" style="font-size:11px;margin-top:4px;font-weight:700">${esc(l.sourceRouteName)}</div>` : ""}</div>
                <div class="state">${stateText}</div>
                ${status === "remaining" ? `<div class="rowmeta"><div class="rowhint">${hint}</div><div class="rowdistance">${distanceText ? `${esc(distanceText)} away` : ""}</div></div>` : ""}`;
    if (status === "remaining") d.onclick = () => selectLocation(l.id);
    host.appendChild(d);
  });
}

function selectLocation(id) {
  const r = route();
  if (!r) return;
  const p = progress(r.id);
  const l = r.locations.find((x) => x.id === id);
  if (!l || p[id] || isExpired(l)) return;
  selected = { ...l, distance: distanceFor(l) };
  updateTargetCard();
  renderLocationList();
  window.scrollTo({
    top: document.getElementById("nearName").getBoundingClientRect().top + window.scrollY - 90,
    behavior: "smooth"
  });
}

function gpsLine(candidate, title) {
  return `<strong>${title}</strong> · Accuracy ±${Math.round(candidate.accuracy)} m`;
}

function findLocation() {
  const box = document.getElementById("where");
  if (!navigator.geolocation) {
    box.textContent = "Location not supported.";
    return;
  }
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  let bestAccuracy = Infinity;
  let bestPos = null;
  const started = Date.now();
  box.textContent = "Acquiring GPS…";
  watchId = navigator.geolocation.watchPosition((p) => {
    const candidate = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    if (candidate.accuracy < bestAccuracy) {
      bestAccuracy = candidate.accuracy;
      bestPos = candidate;
      pos = candidate;
      const quality = candidate.accuracy <= 30 ? "GPS locked"
        : candidate.accuracy <= 75 ? "Good GPS fix"
          : candidate.accuracy <= 200 ? "Improving GPS…"
            : "Waiting for precise GPS…";
      box.innerHTML = gpsLine(candidate, quality);
      calcNearest();
      renderLocationList();
    }
    if (candidate.accuracy <= 30 || Date.now() - started > 15000) {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      if (bestPos) {
        pos = bestPos;
        if (bestAccuracy > 75) {
          box.innerHTML = gpsLine(bestPos, "Using best available location");
        }
        calcNearest();
        renderLocationList();
        reverseLookup();
      }
    }
  }, (e) => {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    box.textContent = "Could not get GPS. Check Chrome precise-location permission.";
    console.error(e);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

async function nominatimJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en-AU"
    }
  });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  return res.json();
}

function formatClosestAddress(result) {
  const a = result.address || {};
  const road = a.road || a.pedestrian || a.residential || a.footway || a.path || "";
  const street = [a.house_number, road].filter(Boolean).join(" ");
  const place = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || "";
  if (street && place) return `${street}, ${place}`;
  if (street) return street;
  if (result.display_name) return result.display_name.split(",").slice(0, 3).join(",").trim();
  return "";
}

async function reverseLookup() {
  if (!pos) return;
  const box = document.getElementById("where");
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.lat}&lon=${pos.lng}&zoom=18&addressdetails=1`;
    const x = await nominatimJson(u);
    const label = formatClosestAddress(x);
    if (label) box.innerHTML = `<strong>Closest address:</strong> ${esc(label)}`;
  } catch (e) { /* geocoder optional */ }
}

function hav(a, b, c, d) {
  const R = 6371000;
  const k = Math.PI / 180;
  const da = (c - a) * k;
  const db = (d - b) * k;
  const q = Math.sin(da / 2) ** 2 + Math.cos(a * k) * Math.cos(c * k) * Math.sin(db / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function calcNearest() {
  const r = route();
  if (!r) return;
  const p = progress(r.id);
  const remain = r.locations.filter((l) => !p[l.id] && !isExpired(l));
  const buttons = ["nav", "navRoute", "complete", "skip"].map((x) => document.getElementById(x));
  if (selected && isExpired(selected)) selected = null;
  if (!remain.length) {
    nearest = null;
    selected = null;
    updateTargetCard();
    buttons.forEach((b) => { b.disabled = true; });
    renderLocationList();
    return;
  }
  if (!pos) {
    nearest = null;
    if (selected && (p[selected.id] || isExpired(selected))) selected = null;
    updateTargetCard();
    buttons.forEach((b) => { b.disabled = true; });
    renderLocationList();
    return;
  }
  const candidates = remain.filter((l) => coordsFor(l)).map((l) => ({ ...l, distance: distanceFor(l) })).sort((a, b) => a.distance - b.distance);
  nearest = candidates[0] || null;
  if (selected && (p[selected.id] || isExpired(selected))) selected = null;
  if (!selected && nearest) selected = { ...nearest };
  if (selected) {
    const original = remain.find((l) => l.id === selected.id);
    if (original) selected = { ...original, distance: distanceFor(original) };
  }
  updateTargetCard();
  const usable = !!selected;
  buttons.forEach((b) => { b.disabled = !usable; });
  renderLocationList();
}

function updateTargetCard() {
  const nn = document.getElementById("nearName");
  const nd = document.getElementById("nearDetail");
  const dist = document.getElementById("nearDistance");
  const hint = document.getElementById("selectionHint");
  const r = route();
  const p = r ? progress(r.id) : {};
  const active = r ? r.locations.filter((l) => !p[l.id] && !isExpired(l)) : [];
  const unfinished = r ? r.locations.filter((l) => !p[l.id]) : [];
  if (r && !active.length) {
    nn.textContent = unfinished.length ? "No active locations remaining" : "Route finished";
    nd.textContent = unfinished.length ? "Any unfinished locations have reached their route cut-off time." : "All locations completed or skipped.";
    dist.textContent = "";
    hint.textContent = "";
    return;
  }
  if (!pos) {
    nn.textContent = selected ? selected.name : "Waiting for your GPS location…";
    nd.textContent = selected ? selected.detail : "";
    dist.textContent = "";
    hint.textContent = selected
      ? "Selected manually. GPS distance will appear when location is available."
      : "Nearest active location will be selected automatically once GPS is available.";
    return;
  }
  if (!selected) {
    nn.textContent = "Preparing route locations…";
    nd.textContent = "The app is locating the streets for the first use of this route.";
    dist.textContent = "";
    hint.textContent = "You can still tap an active location in the list to select it.";
    return;
  }
  nn.textContent = selected.name;
  nd.textContent = selected.detail;
  dist.textContent = selected.distance == null ? "Distance unavailable" : `${formatDistance(selected.distance)} away`;
  hint.textContent = nearest && selected.id === nearest.id
    ? "Nearest active location. Tap any other active location below to choose it instead."
    : "Manually selected active location. It does not have to be the nearest.";
}

async function geocodeMissing() {
  const r = route();
  if (!r) return;
  const missing = r.locations.filter((l) => !hasExactCoords(l) && !geocache[l.query]);
  const s = document.getElementById("geoStatus");
  if (!missing.length) {
    s.textContent = "Route locations ready.";
    calcNearest();
    return;
  }
  s.textContent = `Preparing ${missing.length} route location${missing.length === 1 ? "" : "s"} for nearest-location calculations…`;
  let n = 0;
  for (const l of missing) {
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=au&q=${encodeURIComponent(l.query)}`;
      const arr = await nominatimJson(u);
      if (arr && arr[0]) {
        geocache[l.query] = { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
        localStorage.setItem("peak_geocache", JSON.stringify(geocache));
      }
    } catch (e) { /* continue remaining stops */ }
    n++;
    s.textContent = `Preparing route locations… ${n}/${missing.length}`;
    calcNearest();
    await new Promise((res) => setTimeout(res, 1100));
  }
  s.textContent = "Route preparation finished. Any street that could not be found can still be opened directly in Google Maps.";
  calcNearest();
}

function mark(st) {
  if (!selected || isExpired(selected)) {
    renderDash();
    return;
  }
  const p = progress(currentId);
  p[selected.id] = st;
  saveProgress(currentId, p);
  selected = null;
  nearest = null;
  renderDash();
  findLocation();
}

function navigate() {
  if (!selected) return;
  const g = coordsFor(selected);
  const dest = g ? `${g.lat},${g.lng}` : selected.query;
  location.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
}

function navigationOrder() {
  const r = route();
  if (!r) return [];
  const p = progress(r.id);
  const remain = r.locations.filter((l) => !p[l.id] && !isExpired(l));
  const sorted = remain.map((l, idx) => ({ l, idx, d: distanceFor(l) })).sort((a, b) => {
    if (a.d == null && b.d == null) return a.idx - b.idx;
    if (a.d == null) return 1;
    if (b.d == null) return -1;
    return a.d - b.d;
  }).map((x) => x.l);
  if (selected) {
    const chosen = sorted.find((l) => l.id === selected.id);
    if (chosen) return [chosen, ...sorted.filter((l) => l.id !== selected.id)];
  }
  return sorted;
}

function mapsPoint(l) {
  const g = coordsFor(l);
  return g ? `${g.lat},${g.lng}` : l.query;
}

function navigateRemainingRoute() {
  const ordered = navigationOrder();
  if (!ordered.length) return;
  const batch = ordered.slice(0, 10);
  if (batch.length === 1) {
    const dest = mapsPoint(batch[0]);
    location.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
    return;
  }
  const destination = mapsPoint(batch[batch.length - 1]);
  const waypoints = batch.slice(0, -1).map(mapsPoint).join("|");
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&waypoints=${encodeURIComponent(waypoints)}&travelmode=driving`;
  location.href = url;
}

function resetRoute() {
  if (currentId && confirm("Reset all completed and skipped locations for this route?")) {
    currentId.split("+").forEach((id) => localStorage.removeItem(progKey(id)));
    renderDash();
    findLocation();
  }
}

async function refreshRouteData() {
  setRouteDataStatus("Checking for route updates…", "");
  try {
    await loadLatestRoutes();
    if (currentId) renderDash();
    else renderRoutes();
  } catch (e) {
    console.error(e);
  }
}

function bindUi() {
  document.getElementById("findMe").onclick = findLocation;
  document.getElementById("findBtn").onclick = findLocation;
  document.getElementById("recalc").onclick = () => { findLocation(); geocodeMissing(); };
  document.getElementById("nav").onclick = navigate;
  document.getElementById("navRoute").onclick = navigateRemainingRoute;
  document.getElementById("combineMode").onclick = toggleCombineMode;
  document.getElementById("startCombined").onclick = startCombinedRoutes;
  document.getElementById("complete").onclick = () => mark("complete");
  document.getElementById("skip").onclick = () => mark("skipped");
  document.getElementById("reset").onclick = resetRoute;
  document.getElementById("change").onclick = showSelect;
  document.getElementById("routesBtn").onclick = showSelect;
  document.getElementById("refreshRoutes").onclick = refreshRouteData;
}

async function startApp() {
  bindUi();
  const versionEl = document.getElementById("appVersionLabel");
  if (versionEl) versionEl.textContent = `Route Runner ${APP_VERSION}`;
  try {
    await loadLatestRoutes();
  } catch (e) {
    console.error(e);
  }
  updateCombineUI();
  renderRoutes();
  if (currentId) {
    const ids = currentId.split("+");
    if (ids.every((id) => ROUTES.some((r) => r.id === id))) openRoute(currentId);
    else showSelect();
  }
}

startApp();

setInterval(() => {
  if (currentId && !document.getElementById("dash").classList.contains("hidden")) {
    renderDash();
  }
}, 30000);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      await reg.update();
      const appStatus = document.getElementById("appUpdateStatus");
      if (appStatus) appStatus.textContent = `Route Runner ${APP_VERSION}`;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (sessionStorage.getItem("peak_reloaded_for_update")) return;
        sessionStorage.setItem("peak_reloaded_for_update", "1");
        location.reload();
      });
    } catch (e) {
      const appStatus = document.getElementById("appUpdateStatus");
      if (appStatus) {
        appStatus.textContent = "Update check unavailable";
        appStatus.className = "updatewarn";
      }
    }
  });
}
