const APP_VERSION = "v1.1";
const ACCESS_SALT = "peak-route-runner";
const ACCESS_HASH = "2918fd829429cfa0a8d97c1b105cecc60f28158d3aa38042506701e5dc1221d3";
const ACCESS_SESSION_KEY = "peak_unlocked";

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

function showSelect() {
  selected = null;
  selectedManual = false;
  nearest = null;
  currentId = null;
  combineMode = false;
  combineSelection = [];
  resetStreetExpand();
  localStorage.removeItem("peak_current");
  document.getElementById("select").classList.remove("hidden");
  document.getElementById("dash").classList.add("hidden");
  updateCombineUI();
  renderRoutes();
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
  const hint = status === "remaining" && selected && selected.id === l.id
    ? "First for remaining route"
    : "";
  const titleHtml = hideName
    ? `<div class="muted">${esc(l.detail || l.name)}</div>`
    : `<strong>${esc(l.name)}</strong><div class="muted">${esc(l.detail)}</div>`;
  d.innerHTML = `<div class="locrow-main"><div class="rowtop">${titleHtml}${l.sourceRouteName ? `<div class="muted sourceroute">${esc(l.sourceRouteName)}</div>` : ""}</div>
                ${stateText ? `<div class="state">${stateText}</div>` : ""}
                ${status === "remaining" ? `<div class="rowmeta"><div class="rowhint">${hint}</div><div class="rowdistance">${distanceText ? `${esc(distanceText)} away` : ""}</div></div>` : ""}</div>`;
  if (status === "remaining") {
    d.prepend(createNavButton(l));
    d.appendChild(createDoneButton(l));
    d.onclick = () => selectLocation(l.id);
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
  if (navRoute) navRoute.disabled = !selected;
  renderLocationList();
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
  const remain = r.locations.map((l, idx) => ({ l, idx, distance: distanceFor(l) }))
    .filter((x) => !p[x.l.id] && !isExpired(x.l));
  const sorted = remain.sort(compareRemaining).map((x) => x.l);
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

function applyReset() {
  currentId.split("+").forEach((id) => localStorage.removeItem(progKey(id)));
  renderDash();
  findLocation();
}

function closeResetDialog() {
  document.getElementById("resetDialog").classList.add("hidden");
}

function resetRoute() {
  if (!currentId) return;
  document.getElementById("resetDialog").classList.remove("hidden");
  document.getElementById("resetCancel").focus();
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

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showLockError(visible) {
  document.getElementById("lockError").classList.toggle("hidden", !visible);
}

function unlockApp() {
  sessionStorage.setItem(ACCESS_SESSION_KEY, "1");
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
  document.getElementById("findBtn").onclick = findLocation;
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("resetDialog").classList.contains("hidden")) {
      closeResetDialog();
    }
  });
  document.getElementById("change").onclick = showSelect;
  document.getElementById("routesBtn").onclick = showSelect;
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
  if (currentId) {
    const ids = currentId.split("+");
    if (ids.every((id) => ROUTES.some((r) => r.id === id))) openRoute(currentId);
    else showSelect();
  }
}

bindLockUi();
if (sessionStorage.getItem(ACCESS_SESSION_KEY) === "1") {
  unlockApp();
  startApp();
} else {
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
