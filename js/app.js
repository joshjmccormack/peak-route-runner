const APP_VERSION = "v1.1";
const ACCESS_SALT = "peak-route-runner";
const ACCESS_HASH = "2918fd829429cfa0a8d97c1b105cecc60f28158d3aa38042506701e5dc1221d3";
const ACCESS_SESSION_KEY = "peak_unlocked";
const SCREEN_IDS = ["home", "select", "runMaps", "dash"];
const RUNMAP_PREFIX = "runmap:";
const SHOW_ALL_MAPS_URL = "https://www.google.com/maps/d/u/1/edit?mid=1du12Xr1YcXO5iB9CEYstssvNaV92LZI&usp=sharing";
const RUN_MAPS = [
  { id: "1-6", name: "Run: 1, 2, 3, 4, 5 & 6", suburb: "Brisbane City", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1qQuzEAXdgHALbVtl5abd9yciKm-egBA&usp=sharing" },
  { id: "7-16", name: "Run: 7 & 16", suburb: "Fortitude Valley, New Farm, Newstead and Teneriffe", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1KO4TyHNX4vFgjgE2StLLxnXZG3V-S9w&usp=sharing" },
  { id: "8-9", name: "Run: 8 & 9", suburb: "Brisbane City, Fortitude Valley and Spring Hill", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1mxbsQahdnSsmFYPuaSew6OlBXd6_5T4&usp=sharing" },
  { id: "10", name: "Run: 10", suburb: "Bowen Hills, Fortitude Valley, and Newstead", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1cVf5jLmCieYrcPYXAbgYFffmTVxh0pE&usp=sharing" },
  { id: "11", name: "Run: 11", suburb: "East Brisbane, Highgate Hill, Kangaroo Point, South Brisbane, West End and Woolloongabba", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1fJwEG-oHxfPbS5s2Vhy7xv16nU_sE3A&usp=sharing" },
  { id: "12", name: "Run: 12", suburb: "East Brisbane, Highgate Hill, Kangaroo Point, South Brisbane, West End and Woolloongabba", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1E5EQkXGgTI1bqXaE6hbcoupm6dv1mkE&usp=sharing" },
  { id: "13-19", name: "Run: 13 & 19", suburb: "Auchenflower, Brisbane City, Kelvin Grove, Milton, Paddington and Red Hill", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1zPubT82SCib4vL_c2uHcgj6bHD2EzFM&usp=sharing" },
  { id: "14-15", name: "Run: 14 & 15", suburb: "Auchenflower, Brisbane City, Kelvin Grove, Milton, Paddington and Red Hill", mapsUrl: SHOW_ALL_MAPS_URL },
  { id: "17", name: "Run: 17", suburb: "Herston and Kelvin Grove", mapsUrl: SHOW_ALL_MAPS_URL },
  { id: "18", name: "Run: 18", suburb: "Annerley and Woolloongabba", mapsUrl: SHOW_ALL_MAPS_URL },
  { id: "19", name: "Run: 19", mapsUrl: SHOW_ALL_MAPS_URL },
  { id: "st-lucia", name: "Run: St Lucia", suburb: "St Lucia", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1vfToweHksS1oYf7RbMeqgGAoL9JdXs4&usp=sharing" },
  { id: "all", name: "Show All", wide: true, mapsUrl: SHOW_ALL_MAPS_URL }
];

let ROUTES = [];
let currentId = localStorage.getItem("peak_current") || null;
let pos = null;
let nearest = null;
let selected = null;
let watchId = null;
let combineMode = false;
let combineSelection = [];
let selectedManual = false;
const streetExpanded = {};
let lastExpandSelectedId = null;
const SORT_MODE_KEY = "peak_sort_mode";
let sortMode = localStorage.getItem(SORT_MODE_KEY) === "route" ? "route" : "nearest";
const geocache = JSON.parse(localStorage.getItem("peak_geocache") || "{}");

const ROUTE_DATA_CACHE_KEY = "peak_routes_cache_v12";
const ROUTE_DATA_UPDATED_KEY = "peak_routes_updated_v12";

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

function walkJsText(text, onPlain, onStringChar) {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (onStringChar) onStringChar(ch, i);
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      if (onPlain) onPlain(ch, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1;
      continue;
    }
    if (onPlain) onPlain(ch, i);
  }
}

function stripJsComments(text) {
  let out = "";
  walkJsText(text, (ch) => { out += ch; }, (ch) => { out += ch; });
  return out;
}

function extractRoutesArray(text) {
  const m = text.match(/const\s+ROUTES\s*=/);
  if (!m) throw new Error("Invalid routes.js format");
  const start = text.indexOf("[", m.index + m[0].length - 1);
  if (start < 0) throw new Error("Invalid routes.js format");
  let depth = 0;
  let end = -1;
  walkJsText(text.slice(start), (ch, i) => {
    if (end >= 0) return;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) end = start + i;
    }
  });
  if (end < 0) throw new Error("Invalid routes.js format");
  return text.slice(start, end + 1);
}

function insertMissingCommas(text) {
  let out = "";
  let pending = "";
  walkJsText(text, (ch) => {
    if (ch === "}" || ch === "]") {
      out += pending + ch;
      pending = "";
      return;
    }
    if (/\s/.test(ch)) {
      if (out.endsWith("}") || out.endsWith("]")) pending += ch;
      else out += ch;
      return;
    }
    if ((ch === "{" || ch === "[") && (out.endsWith("}") || out.endsWith("]"))) {
      out += pending + "," + ch;
      pending = "";
      return;
    }
    out += pending + ch;
    pending = "";
  }, (ch) => {
    out += pending + ch;
    pending = "";
  });
  return out + pending;
}

function parseRoutesJs(text) {
  const extracted = extractRoutesArray(stripJsComments(text));
  return JSON.parse(stripTrailingCommas(insertMissingCommas(extracted)));
}

function locCardDetail(loc) {
  return String(loc && loc.detail || "").trim();
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
      const derived = expireTimeFromDetail(loc.detailLong || loc.detail);
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

function isRunMapId(id) {
  return String(id || "").startsWith(RUNMAP_PREFIX);
}

function runMapFromCurrent() {
  if (!isRunMapId(currentId)) return null;
  const key = currentId.slice(RUNMAP_PREFIX.length);
  return RUN_MAPS.find((m) => m.id === key) || null;
}

function route() {
  if (!currentId) return null;
  const runMap = runMapFromCurrent();
  if (runMap) {
    return { id: currentId, name: runMap.name, locations: [] };
  }
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

function isRouteSort() {
  return sortMode === "route";
}

function persistSortMode() {
  localStorage.setItem(SORT_MODE_KEY, sortMode);
}

function recommendedOrder(l) {
  const n = Number(l && l.order);
  return Number.isFinite(n) ? n : null;
}

function compareRemaining(a, b) {
  if (isRouteSort()) {
    const ao = recommendedOrder(a.l);
    const bo = recommendedOrder(b.l);
    const aMissing = ao == null;
    const bMissing = bo == null;
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && ao !== bo) return ao - bo;
    return a.idx - b.idx;
  }
  if (a.distance == null && b.distance == null) return a.idx - b.idx;
  if (a.distance == null) return 1;
  if (b.distance == null) return -1;
  return a.distance - b.distance;
}

function setSortMode(mode) {
  const next = mode === "route" ? "route" : "nearest";
  if (next === sortMode) return;
  sortMode = next;
  persistSortMode();
  if (!selectedManual) selected = null;
  updateSortToggle();
  if (currentId) calcNearest();
}

function updateSortToggle() {
  const nearestBtn = document.getElementById("sortNearest");
  const recommendedBtn = document.getElementById("sortRecommended");
  const hint = document.getElementById("sortHint");
  const routeOrder = isRouteSort();
  if (nearestBtn) nearestBtn.setAttribute("aria-pressed", String(!routeOrder));
  if (recommendedBtn) recommendedBtn.setAttribute("aria-pressed", String(routeOrder));
  if (hint) {
    hint.textContent = routeOrder
      ? "Remaining stops follow the recommended order"
      : "Remaining stops are listed closest first.";
  }
}

function resetStreetExpand() {
  Object.keys(streetExpanded).forEach((k) => { delete streetExpanded[k]; });
  lastExpandSelectedId = null;
}

function rememberSelectedStreet() {
  if (!selected) return;
  if (lastExpandSelectedId === selected.id) return;
  lastExpandSelectedId = selected.id;
  streetExpanded[selected.name] = true;
}

function streetIsOpen(name, containsSelected) {
  if (Object.prototype.hasOwnProperty.call(streetExpanded, name)) {
    return streetExpanded[name];
  }
  return containsSelected;
}

function hideAllScreens() {
  SCREEN_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}

function showScreen(id) {
  hideAllScreens();
  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

function isHomeVisible() {
  const home = document.getElementById("home");
  return !!(home && !home.classList.contains("hidden"));
}

function showHome() {
  if (isHomeVisible()) return;
  combineMode = false;
  combineSelection = [];
  if (isRunMapId(currentId)) {
    selected = null;
    selectedManual = false;
    nearest = null;
    currentId = null;
    resetStreetExpand();
  }
  showScreen("home");
}

function showPeakPicker(abandon) {
  if (abandon) {
    selected = null;
    selectedManual = false;
    nearest = null;
    currentId = null;
    resetStreetExpand();
    localStorage.removeItem("peak_current");
  }
  combineMode = false;
  combineSelection = [];
  showScreen("select");
  updateCombineUI();
  renderRoutes();
}

function showRunMaps() {
  if (isRunMapId(currentId)) {
    selected = null;
    selectedManual = false;
    nearest = null;
    currentId = null;
    resetStreetExpand();
  }
  showScreen("runMaps");
  renderRunMaps();
}

function chooseAnotherRoute() {
  if (isRunMapId(currentId)) {
    showRunMaps();
    return;
  }
  showPeakPicker(true);
}

function renderRunMaps() {
  const host = document.getElementById("runMapGroups");
  if (!host) return;
  host.innerHTML = "";
  RUN_MAPS.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = m.wide ? "routebtn runmap-all" : "routebtn";
    b.innerHTML = `<strong>${esc(m.name)}</strong>${m.suburb ? `<span>${esc(m.suburb)}</span>` : ""}`;
    b.onclick = () => openRunMap(m.id);
    host.appendChild(b);
  });
}

function peakToneClass(group) {
  return String(group || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderRoutes() {
  const host = document.getElementById("routeGroups");
  host.innerHTML = "";
  [...new Set(ROUTES.map((r) => r.group))].forEach((g) => {
    const tone = peakToneClass(g);
    const title = document.createElement("div");
    title.className = tone ? `group ${tone}` : "group";
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
      b.className = tone ? `routebtn ${tone}` : "routebtn";
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
  selectedManual = false;
  nearest = null;
  resetStreetExpand();
  currentId = id;
  localStorage.setItem("peak_current", id);
  showScreen("dash");
  renderDash();
  findLocation();
  geocodeMissing();
}

function myMapsViewerUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const mid = parsed.searchParams.get("mid");
    if (!mid) return url;
    return `https://www.google.com/maps/d/viewer?mid=${encodeURIComponent(mid)}&usp=sharing`;
  } catch (e) {
    return url;
  }
}

function openInGoogleMapsApp(url) {
  const httpsUrl = myMapsViewerUrl(url);
  const ua = navigator.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  if (isAndroid) {
    const path = httpsUrl.replace(/^https:\/\//i, "");
    location.href = `intent://${path}#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
    return;
  }
  const link = document.createElement("a");
  link.href = httpsUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openRunMap(id) {
  const map = RUN_MAPS.find((m) => m.id === id);
  if (!map || !map.mapsUrl) return;
  openInGoogleMapsApp(map.mapsUrl);
}

function setDashEmptyState(isEmpty) {
  const extras = document.getElementById("dashListControls");
  if (extras) extras.classList.toggle("hidden", isEmpty);
  const tools = document.getElementById("dashRouteTools");
  if (tools) tools.classList.toggle("hidden", isEmpty);
}

function renderDash() {
  const r = route();
  if (!r) {
    currentId = null;
    localStorage.removeItem("peak_current");
    return showHome();
  }
  const p = progress(r.id);
  const done = Object.values(p).filter((x) => x === "complete").length;
  const skipped = Object.values(p).filter((x) => x === "skipped").length;
  const expired = r.locations.filter((l) => !p[l.id] && isExpired(l)).length;
  const active = r.locations.filter((l) => !p[l.id] && !isExpired(l)).length;
  const isEmpty = !r.locations.length;
  document.getElementById("routeTitle").textContent = r.name;
  document.getElementById("remainPill").textContent = `${active} active`;
  document.getElementById("donePill").textContent = `${done} complete`;
  document.getElementById("skipPill").textContent = `${skipped} skipped`;
  document.getElementById("expiredPill").textContent = `${expired} expired`;
  setDashEmptyState(isEmpty);
  updateSortToggle();
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

function brisbaneDateToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value || "0000";
  const m = parts.find((p) => p.type === "month")?.value || "00";
  const d = parts.find((p) => p.type === "day")?.value || "00";
  return `${y}-${m}-${d}`;
}

function isUnlockedToday() {
  return localStorage.getItem(ACCESS_SESSION_KEY) === brisbaneDateToday();
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

function statusRank(status) {
  if (status === "remaining") return 0;
  if (status === "expired") return 2;
  return 1;
}

function streetSummary(items) {
  const active = items.filter((x) => x.status === "remaining").length;
  const complete = items.filter((x) => x.status === "complete").length;
  const skipped = items.filter((x) => x.status === "skipped").length;
  const expired = items.filter((x) => x.status === "expired").length;
  const parts = [];
  if (active) parts.push(`${active} active`);
  if (complete) parts.push(`${complete} complete`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (expired) parts.push(`${expired} expired`);
  return parts.join(" · ") || `${items.length} stop${items.length === 1 ? "" : "s"}`;
}

function streetParentStatus(items) {
  if (items.some((x) => x.status === "remaining")) return "remaining";
  const leftover = items.filter((x) => x.status !== "complete" && x.status !== "skipped");
  if (leftover.length && leftover.every((x) => x.status === "expired")) return "expired";
  if (items.every((x) => x.status === "skipped")) return "skipped";
  if (items.every((x) => x.status === "complete" || x.status === "skipped")) return "complete";
  return "remaining";
}

function streetExpiredLabel(items) {
  let best = null;
  items.forEach((x) => {
    if (x.status !== "expired") return;
    const mins = expiryMinutes(x.l);
    if (mins == null) return;
    if (best == null || mins > best.mins) best = { mins, time: x.l.expireTime };
  });
  return best ? `⏱ Expired at ${formatClock24(best.time)}` : "⏱ Expired";
}

function sortStreetRows(items) {
  const remaining = items.filter((x) => x.status === "remaining").sort(compareRemaining);
  const finished = items.filter((x) => x.status !== "remaining").sort((a, b) => {
    const ar = statusRank(a.status);
    const br = statusRank(b.status);
    if (ar !== br) return ar - br;
    return a.idx - b.idx;
  });
  return [...remaining, ...finished];
}

const NAV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M8.4 18.45V12.1C8.4 8.9 10.75 7.25 14.15 7.25H16.9"/><path fill="currentColor" d="M15.55 4.6 21.45 7.45l-5.9 2.85z"/></svg>';
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#d32f2f" d="M12 21.8s7.15-7.05 7.15-12.05A7.15 7.15 0 0 0 12 2.6 7.15 7.15 0 0 0 4.85 9.75C4.85 14.75 12 21.8 12 21.8z"/><circle fill="#fff" cx="12" cy="9.55" r="2.55"/></svg>';

function locationPhotoSrc(loc) {
  const raw = loc && typeof loc.photo === "string" ? loc.photo.trim() : "";
  if (!/^photos\/[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(raw)) return "";
  return raw;
}

function showPhotoEmpty(host) {
  host.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "photo-empty";
  empty.textContent = "No map screenshot yet.";
  host.appendChild(empty);
}

function closePhotoDialog() {
  const overlay = document.getElementById("photoDialog");
  if (overlay) overlay.classList.add("hidden");
}

function openPhotoDialog(loc) {
  const overlay = document.getElementById("photoDialog");
  const title = document.getElementById("photoDialogTitle");
  const detail = document.getElementById("photoDialogDetail");
  const body = document.getElementById("photoDialogBody");
  if (!overlay || !title || !detail || !body) return;
  title.textContent = loc.name || "Location";
  const detailText = loc.detailLong || loc.detail || "";
  detail.textContent = detailText;
  detail.classList.toggle("hidden", !detailText);
  const src = locationPhotoSrc(loc);
  if (!src) {
    showPhotoEmpty(body);
  } else {
    body.replaceChildren();
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Map screenshot of ${loc.name || "this location"}`;
    img.onerror = () => showPhotoEmpty(body);
    body.appendChild(img);
  }
  overlay.classList.remove("hidden");
  const closeBtn = document.getElementById("photoDialogClose");
  if (closeBtn) closeBtn.focus();
}

function createNavButton(loc) {
  const navBtn = document.createElement("button");
  navBtn.type = "button";
  navBtn.className = "locact locact-nav";
  navBtn.setAttribute("aria-label", `Navigate to ${loc.name}`);
  navBtn.innerHTML = NAV_ICON;
  navBtn.onclick = (e) => {
    e.stopPropagation();
    navigateTo(loc);
  };
  return navBtn;
}

function createDoneButton(loc) {
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "locact locact-done";
  doneBtn.setAttribute("aria-label", `Complete ${loc.name}`);
  doneBtn.textContent = "✓";
  doneBtn.onclick = (e) => {
    e.stopPropagation();
    markLocation(loc.id, "complete");
  };
  return doneBtn;
}

function createPhotoButton(loc) {
  const photoBtn = document.createElement("button");
  photoBtn.type = "button";
  photoBtn.className = "locact locact-photo";
  photoBtn.setAttribute("aria-label", `Map screenshot for ${loc.name}`);
  photoBtn.innerHTML = PIN_ICON;
  photoBtn.onclick = (e) => {
    e.stopPropagation();
    openPhotoDialog(loc);
  };
  return photoBtn;
}

function createLocRow(row, hideName) {
  const { l, distance, status } = row;
  const d = document.createElement("div");
  d.className = "locrow";
  if (hideName) d.classList.add("segment");
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
        : "";
  const cardDetail = locCardDetail(l);
  const titleHtml = hideName
    ? `<div class="muted">${esc(cardDetail || l.name)}</div>`
    : `<strong>${esc(l.name)}</strong>${cardDetail ? `<div class="muted">${esc(cardDetail)}</div>` : ""}`;
  d.innerHTML = `<div class="locrow-main"><div class="rowtop">${titleHtml}${l.sourceRouteName ? `<div class="muted sourceroute">${esc(l.sourceRouteName)}</div>` : ""}</div>
                ${stateText ? `<div class="state">${stateText}</div>` : ""}</div>${status === "remaining" && distanceText ? `<div class="rowdistance">${esc(distanceText)} away</div>` : ""}`;
  if (status === "remaining") {
    d.prepend(createNavButton(l));
    const navEl = d.querySelector(".locact-nav");
    navEl.after(createPhotoButton(l));
    d.appendChild(createDoneButton(l));
    d.onclick = () => selectLocation(l.id);
  } else {
    d.appendChild(createPhotoButton(l));
  }
  return d;
}

function createStreetCard(name, items) {
  const remaining = items.filter((x) => x.status === "remaining");
  const parentStatus = streetParentStatus(items);
  const containsSelected = !!(selected && items.some((x) => x.l.id === selected.id));
  const open = streetIsOpen(name, containsSelected && remaining.length > 0);
  const card = document.createElement("div");
  card.className = "streetcard";
  if (open) card.classList.add("open");
  if (containsSelected) card.classList.add("has-selected");
  if (parentStatus === "complete") card.classList.add("completed");
  else if (parentStatus === "skipped") card.classList.add("skipped");
  else if (parentStatus === "expired") card.classList.add("expired");
  else card.classList.add("remaining");
  const statusLine = parentStatus === "expired"
    ? `<div class="state">${esc(streetExpiredLabel(items))}</div>`
    : parentStatus === "complete" ? `<div class="state">✓ Completed</div>`
      : parentStatus === "skipped" ? `<div class="state">↷ Skipped</div>`
        : `<div class="streetsum">${esc(streetSummary(items))}</div>`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "streethead";
  head.setAttribute("aria-expanded", String(open));
  head.innerHTML = `<div class="streetcopy"><strong>${esc(name)}</strong>${statusLine}</div><span class="streetchevron" aria-hidden="true">${open ? "▾" : "▸"}</span>`;
  head.onclick = () => {
    streetExpanded[name] = !open;
    renderLocationList();
  };
  card.appendChild(head);
  if (open) {
    const segs = document.createElement("div");
    segs.className = "streetsegs";
    sortStreetRows(items).forEach((row) => segs.appendChild(createLocRow(row, true)));
    card.appendChild(segs);
  }
  return card;
}

function renderLocationList() {
  const r = route();
  if (!r) return;
  rememberSelectedStreet();
  const p = progress(r.id);
  const host = document.getElementById("list");
  host.innerHTML = "";
  if (!r.locations.length) {
    host.innerHTML = `<p class="notice">No locations yet.</p>`;
    return;
  }
  const rows = r.locations.map((l, idx) => {
    const saved = p[l.id] || "remaining";
    const status = (saved === "remaining" && isExpired(l)) ? "expired" : saved;
    return { l, idx, distance: distanceFor(l), status };
  });
  const byName = new Map();
  rows.forEach((row) => {
    const key = row.l.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  });
  const groups = [...byName.entries()].map(([name, items]) => {
    const remaining = items.filter((x) => x.status === "remaining").sort(compareRemaining);
    return { name, items, remaining, isActive: remaining.length > 0 };
  });
  const active = groups.filter((g) => g.isActive);
  const finished = groups.filter((g) => !g.isActive);
  active.sort((a, b) => compareRemaining(a.remaining[0], b.remaining[0]));
  finished.sort((a, b) => {
    const aAllExpired = a.items.every((x) => x.status === "expired");
    const bAllExpired = b.items.every((x) => x.status === "expired");
    if (aAllExpired !== bAllExpired) return aAllExpired ? 1 : -1;
    return Math.min(...a.items.map((x) => x.idx)) - Math.min(...b.items.map((x) => x.idx));
  });
  [...active, ...finished].forEach((g) => {
    if (g.items.length > 1) host.appendChild(createStreetCard(g.name, g.items));
    else host.appendChild(createLocRow(g.items[0], false));
  });
}

function selectLocation(id) {
  const r = route();
  if (!r) return;
  const p = progress(r.id);
  const l = r.locations.find((x) => x.id === id);
  if (!l || p[id] || isExpired(l)) return;
  selected = { ...l, distance: distanceFor(l) };
  selectedManual = true;
  renderLocationList();
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

function looksLikeHouseNumber(value) {
  return /^(?:\d+[A-Za-z]?|\d+[A-Za-z]?(?:-\d+[A-Za-z]?)+)$/.test(String(value || "").trim());
}

function formatDisplayNameFallback(displayName) {
  if (!displayName) return "";
  const skip = /^(Australia|Queensland|QLD|\d{4})$/i;
  const parts = String(displayName).split(",").map((p) => p.trim()).filter((p) => p && !skip.test(p));
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

function formatClosestAddress(result) {
  const a = result.address || {};
  const road = String(a.road || a.pedestrian || a.residential || a.footway || a.path || "").trim();
  let houseNumber = String(a.house_number || "").trim();
  if (!houseNumber && result.display_name) {
    const parts = String(result.display_name).split(",").map((p) => p.trim()).filter(Boolean);
    if (looksLikeHouseNumber(parts[0])) houseNumber = parts[0];
    else if (road) {
      const roadIdx = parts.findIndex((p) => p.toLowerCase() === road.toLowerCase());
      if (roadIdx > 0 && looksLikeHouseNumber(parts[roadIdx - 1])) houseNumber = parts[roadIdx - 1];
    }
  }
  const suburb = String(a.suburb || a.neighbourhood || a.city_district || a.city || a.town || "").trim();
  const street = [houseNumber, road].filter(Boolean).join(" ");
  if (street && suburb) return `${street}, ${suburb}`;
  if (street) return street;
  if (suburb) return suburb;
  return formatDisplayNameFallback(result.display_name);
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
  const navRoute = document.getElementById("navRoute");
  if (!remain.length) {
    nearest = null;
    selected = null;
    selectedManual = false;
    if (navRoute) navRoute.disabled = true;
    renderLocationList();
    return;
  }
  if (selected && (p[selected.id] || isExpired(selected))) {
    selected = null;
    selectedManual = false;
  }
  if (pos) {
    const candidates = remain.filter((l) => coordsFor(l)).map((l) => ({ ...l, distance: distanceFor(l) })).sort((a, b) => a.distance - b.distance);
    nearest = candidates[0] || null;
  } else {
    nearest = null;
  }
  if (!selected) {
    if (isRouteSort()) {
      const first = remain
        .map((l, idx) => ({ l, idx, distance: distanceFor(l) }))
        .sort(compareRemaining)[0];
      if (first) selected = { ...first.l, distance: first.distance };
    } else if (nearest) {
      selected = { ...nearest };
    }
  }
  if (selected) {
    const original = remain.find((l) => l.id === selected.id);
    if (original) selected = { ...original, distance: distanceFor(original) };
  }
  if (navRoute) navRoute.disabled = remain.length === 0;
  renderLocationList();
}

async function geocodeMissing() {
  const r = route();
  if (!r) return;
  const s = document.getElementById("geoStatus");
  if (!r.locations.length) {
    if (s) s.textContent = "";
    return;
  }
  const missing = r.locations.filter((l) => !hasExactCoords(l) && !geocache[l.query]);
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

function markLocation(id, st) {
  const r = route();
  if (!r) return;
  const loc = r.locations.find((x) => x.id === id);
  if (!loc || isExpired(loc)) {
    renderDash();
    return;
  }
  const p = progress(currentId);
  if (p[id]) {
    renderDash();
    return;
  }
  p[id] = st;
  saveProgress(currentId, p);
  if (selected && selected.id === id) {
    selected = null;
    selectedManual = false;
  }
  nearest = null;
  renderDash();
  findLocation();
}

function mark(st) {
  if (!selected) return;
  markLocation(selected.id, st);
}

function navigateTo(loc) {
  if (!loc) return;
  const g = coordsFor(loc);
  const dest = g ? `${g.lat},${g.lng}` : loc.query;
  location.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
}

function navigate() {
  if (!selected) return;
  navigateTo(selected);
}

function navigationOrder() {
  const r = route();
  if (!r) return [];
  const p = progress(r.id);
  return r.locations.map((l, idx) => ({ l, idx, distance: distanceFor(l) }))
    .filter((x) => !p[x.l.id] && !isExpired(x.l))
    .sort(compareRemaining)
    .map((x) => x.l);
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

function applyReset() {
  currentId.split("+").forEach((id) => localStorage.removeItem(progKey(id)));
  renderDash();
  findLocation();
}

function closeResetDialog() {
  document.getElementById("resetDialog").classList.add("hidden");
}

function resetRoute() {
  if (!currentId || isRunMapId(currentId)) return;
  const r = route();
  if (!r || !r.locations.length) return;
  document.getElementById("resetDialog").classList.remove("hidden");
  document.getElementById("resetCancel").focus();
}

async function refreshRouteData() {
  setRouteDataStatus("Checking for route updates…", "");
  try {
    await loadLatestRoutes();
    if (currentId && !isRunMapId(currentId)) renderDash();
    else if (!document.getElementById("select").classList.contains("hidden")) renderRoutes();
  } catch (e) {
    console.error(e);
  }
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showLockError(visible) {
  document.getElementById("lockError").classList.toggle("hidden", !visible);
}

function unlockApp() {
  localStorage.setItem(ACCESS_SESSION_KEY, brisbaneDateToday());
  document.body.classList.remove("locked");
  const lock = document.getElementById("lockScreen");
  if (lock) lock.classList.add("hidden");
}

async function tryUnlock(event) {
  event.preventDefault();
  const pin = document.getElementById("accessPin").value.trim();
  const hash = await sha256Hex(`${ACCESS_SALT}\n${pin}`);
  if (hash !== ACCESS_HASH) {
    showLockError(true);
    document.getElementById("accessPin").value = "";
    document.getElementById("accessPin").focus();
    return;
  }
  showLockError(false);
  unlockApp();
  await startApp();
}

function bindLockUi() {
  const form = document.getElementById("lockForm");
  if (form) form.addEventListener("submit", tryUnlock);
}

function bindUi() {
  document.getElementById("findMe").onclick = findLocation;
  document.getElementById("recalc").onclick = () => { findLocation(); geocodeMissing(); };
  document.getElementById("navRoute").onclick = navigateRemainingRoute;
  document.getElementById("combineMode").onclick = toggleCombineMode;
  document.getElementById("startCombined").onclick = startCombinedRoutes;
  document.getElementById("reset").onclick = resetRoute;
  document.getElementById("resetCancel").onclick = closeResetDialog;
  document.getElementById("resetConfirm").onclick = () => {
    closeResetDialog();
    if (currentId) applyReset();
  };
  document.getElementById("resetDialog").addEventListener("click", (event) => {
    if (event.target.id === "resetDialog") closeResetDialog();
  });
  document.getElementById("photoDialogClose").onclick = closePhotoDialog;
  document.getElementById("photoDialog").addEventListener("click", (event) => {
    if (event.target.id === "photoDialog") closePhotoDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const photo = document.getElementById("photoDialog");
    if (photo && !photo.classList.contains("hidden")) {
      closePhotoDialog();
      return;
    }
    if (!document.getElementById("resetDialog").classList.contains("hidden")) {
      closeResetDialog();
    }
  });
  document.getElementById("change").onclick = chooseAnotherRoute;
  document.getElementById("homeBtn").onclick = showHome;
  document.getElementById("openPeakRoutes").onclick = () => showPeakPicker(false);
  document.getElementById("openRunMaps").onclick = showRunMaps;
  document.getElementById("refreshRoutes").onclick = refreshRouteData;
  document.getElementById("sortNearest").onclick = () => setSortMode("nearest");
  document.getElementById("sortRecommended").onclick = () => setSortMode("route");
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
  updateSortToggle();
  renderRoutes();
  renderRunMaps();
  if (currentId && !isRunMapId(currentId)) {
    const ids = currentId.split("+");
    if (ids.every((id) => ROUTES.some((r) => r.id === id))) openRoute(currentId);
    else {
      currentId = null;
      localStorage.removeItem("peak_current");
      showHome();
    }
  } else {
    showHome();
  }
}

bindLockUi();
if (isUnlockedToday()) {
  unlockApp();
  startApp();
} else {
  localStorage.removeItem(ACCESS_SESSION_KEY);
  const pinBox = document.getElementById("accessPin");
  if (pinBox) pinBox.focus();
}

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
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (sessionStorage.getItem("peak_reloaded_for_update")) return;
        sessionStorage.setItem("peak_reloaded_for_update", "1");
        location.reload();
      });
    } catch (e) {
      setRouteDataStatus("Update check unavailable", "updatewarn");
    }
  });
}
