const APP_VERSION = "v1.1";
const SCREEN_IDS = ["home", "select", "runMaps", "dash", "changePassword", "vehicles", "jobClosures", "addOfficer"];
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
  { id: "14-15", name: "Run: 14 & 15", suburb: "Auchenflower, Brisbane City, Kelvin Grove, Milton, Paddington and Red Hill", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1hFI5oztzLmWlsr_Si1zRyq08On86Ga0&usp=sharing" },
  { id: "17", name: "Run: 17", suburb: "Herston and Kelvin Grove", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=19MAXVYIT6Et70I_gDCFYb-7ao62AhHc&usp=sharing" },
  { id: "18", name: "Run: 18", suburb: "Annerley and Woolloongabba", mapsUrl: "https://www.google.com/maps/d/u/1/edit?mid=1OGosRdw8Pk_itL9YBkaYocUedCsY68s&usp=sharing" },
  { id: "20", name: "Run: 20" },
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

function showAddOfficer() {
  if (!isAdmin()) {
    showHome();
    return;
  }
  const form = document.getElementById("addOfficerForm");
  if (form) form.reset();
  newOfficerRole = "officer";
  setChoiceGroup("[data-new-role]", "data-new-role", "officer");
  showAddOfficerStatus("");
  showScreen("addOfficer");
}

function showAddOfficerStatus(message, tone) {
  const el = document.getElementById("addOfficerStatus");
  if (!el) return;
  el.classList.remove("ok", "err");
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
  if (tone) el.classList.add(tone);
}

async function tryAddOfficer(event) {
  event.preventDefault();
  if (!isAdmin()) {
    showAddOfficerStatus("Only an admin can add users.", "err");
    return;
  }
  const sb = getSupabase();
  if (!sb) {
    showAddOfficerStatus("Not signed in.", "err");
    return;
  }
  const displayName = document.getElementById("newOfficerName").value.trim();
  const officerCode = document.getElementById("newOfficerCode").value.trim();
  const email = document.getElementById("newOfficerEmail").value.trim();
  const password = document.getElementById("newOfficerPassword").value;
  const confirm = document.getElementById("newOfficerPasswordConfirm").value;
  if (!displayName) {
    showAddOfficerStatus("Enter a display name.", "err");
    return;
  }
  if (!officerCode) {
    showAddOfficerStatus("Enter an officer code.", "err");
    return;
  }
  if (password.length < 8) {
    showAddOfficerStatus("Password must be at least 8 characters.", "err");
    return;
  }
  if (password !== confirm) {
    showAddOfficerStatus("Passwords do not match.", "err");
    return;
  }
  const btn = document.getElementById("addOfficerBtn");
  if (btn) btn.disabled = true;
  showAddOfficerStatus("");
  try {
    const { data, error } = await sb.functions.invoke("create-user", {
      body: { email, password, role: newOfficerRole, display_name: displayName, officer_code: officerCode }
    });
    if (error) {
      let extra = error.message || "Could not create the login.";
      try {
        const body = await error.context?.json?.();
        if (body?.error) extra = body.error;
      } catch (e) { /* keep extra */ }
      showAddOfficerStatus(extra, "err");
      return;
    }
    if (data?.error) {
      showAddOfficerStatus(data.error, "err");
      return;
    }
    document.getElementById("addOfficerForm").reset();
    newOfficerRole = "officer";
    setChoiceGroup("[data-new-role]", "data-new-role", "officer");
    showAddOfficerStatus(`Created ${data?.display_name || displayName} (${data?.email || email}) as ${roleLabel(data?.role || newOfficerRole)}.`, "ok");
  } catch (e) {
    showAddOfficerStatus("Could not create the login. Deploy the create-user function if it is missing.", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showChangePassword() {
  const form = document.getElementById("changePasswordForm");
  if (form) form.reset();
  showChangePasswordStatus("");
  showScreen("changePassword");
  const current = document.getElementById("currentPassword");
  if (current) current.focus();
}

let vehicleFleet = "";
let vehicleLocation = "";

function vehiclesForFleet(fleet) {
  const lists = window.PEAK_VEHICLES || {};
  const items = lists[fleet];
  return Array.isArray(items) ? items : [];
}

function fillVehicleSelect() {
  const select = document.getElementById("vehicleSelect");
  if (!select) return;
  const list = vehiclesForFleet(vehicleFleet);
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = vehicleFleet
    ? (list.length ? "Select vehicle" : "No vehicles listed for this fleet")
    : "Select fleet first";
  select.appendChild(first);
  list.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.disabled = !vehicleFleet || !list.length;
}

function setChoiceGroup(selector, attr, value) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.getAttribute(attr) === value ? "true" : "false");
  });
}

function setVehicleFleet(fleet) {
  vehicleFleet = fleet;
  setChoiceGroup("[data-fleet]", "data-fleet", fleet);
  fillVehicleSelect();
}

function setVehicleLocation(location) {
  vehicleLocation = location;
  setChoiceGroup("[data-location]", "data-location", location);
}

function showVehicleStatus(message, tone) {
  const el = document.getElementById("vehicleChargeStatus");
  if (!el) return;
  el.classList.remove("ok", "err");
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
  if (tone) el.classList.add(tone);
}

function showVehicles() {
  const form = document.getElementById("vehicleChargeForm");
  if (form) form.reset();
  vehicleFleet = "";
  vehicleLocation = "";
  setChoiceGroup("[data-fleet]", "data-fleet", "");
  setChoiceGroup("[data-location]", "data-location", "");
  fillVehicleSelect();
  showVehicleStatus("");
  applyRoleUi();
  showScreen("vehicles");
  if (canViewChargeLog()) loadVehicleCharges();
}

const JOB_OUTCOMES = {
  not_located: "An officer has attended, and subject vehicle was not located.",
  enforcement: "An officer has attended, and enforcement action was taken.",
  not_in_breach: "An officer attended and located subject vehicle however it was assessed not to be in breach."
};

const JOB_COMPLAINANT = {
  yes: "Yes",
  no: "No",
  left_message: "Yes, left message",
  other: "Other"
};

const JOB_REPORTING = [
  "Ambulance Zone",
  "Authorised Vehicles Only",
  "Bus Stop (7 day KPI)",
  "Bus Zone",
  "Clearway",
  "Disability Parking",
  "Driveway access",
  "Driveway other",
  "Emergency Vehicles",
  "Footway/nature strip",
  "Heavy and Long",
  "Intersection",
  "Loading Zone",
  "Loading Zone Commercial",
  "Loading Zone Other",
  "Loading Zone Passenger",
  "Longer Than Permitted",
  "No Parking",
  "No Standing",
  "Opposite Direction",
  "Other",
  "Parked On Traffic Island",
  "School Zone",
  "Taxi Zone",
  "Tech Advice",
  "Traffic Area",
  "Traffic Area Events",
  "Work Zone",
  "Yellow Line"
];

let jobMediaAttached = "";
let jobCompleteChoice = "";
let jobOutcomeChoice = "";
let jobComplainantChoice = "";
let jobWardChoice = "";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayInputDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fillJobTimeSelects() {
  const hour = document.getElementById("jobHour");
  const minute = document.getElementById("jobMinute");
  if (!hour || !minute) return;
  if (!hour.options.length) {
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = pad2(h);
      opt.textContent = pad2(h);
      hour.appendChild(opt);
    }
  }
  if (!minute.options.length) {
    for (let m = 0; m < 60; m++) {
      const opt = document.createElement("option");
      opt.value = pad2(m);
      opt.textContent = pad2(m);
      minute.appendChild(opt);
    }
  }
}

function fillJobReportingSelect() {
  const el = document.getElementById("jobReporting");
  if (!el || el.options.length > 1) return;
  JOB_REPORTING.forEach((label) => {
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    el.appendChild(opt);
  });
}

function jobAttendanceTime() {
  const hour = document.getElementById("jobHour")?.value;
  const minute = document.getElementById("jobMinute")?.value;
  if (!hour || !minute) return "";
  return `${hour}:${minute}`;
}

function setComplainantOtherVisible(show) {
  const label = document.getElementById("jobComplainantOtherLabel");
  const input = document.getElementById("jobComplainantOther");
  if (label) label.classList.toggle("hidden", !show);
  if (input) {
    input.classList.toggle("hidden", !show);
    if (!show) input.value = "";
  }
}

function jobPhotoFile() {
  return document.getElementById("jobPhoto")?.files?.[0]
    || document.getElementById("jobPhotoCamera")?.files?.[0]
    || null;
}

function clearJobPhoto() {
  ["jobPhoto", "jobPhotoCamera"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
  const preview = document.getElementById("jobPhotoPreview");
  if (preview) {
    preview.src = "";
    preview.classList.add("hidden");
  }
  const clearBtn = document.getElementById("jobPhotoClear");
  if (clearBtn) clearBtn.classList.add("hidden");
}

function setJobPhotoAttachVisible(show) {
  const box = document.getElementById("jobPhotoAttach");
  if (box) box.classList.toggle("hidden", !show);
  if (!show) clearJobPhoto();
}

function showJobPhotoPreview(file) {
  const preview = document.getElementById("jobPhotoPreview");
  const clearBtn = document.getElementById("jobPhotoClear");
  if (!file || !preview) {
    clearJobPhoto();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.classList.remove("hidden");
    if (clearBtn) clearBtn.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function compressJobPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the picture."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        let w = img.width;
        let h = img.height;
        if (w > max || h > max) {
          const scale = Math.min(max / w, max / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) reject(new Error("Could not process the picture."));
          else resolve(blob);
        }, "image/jpeg", 0.72);
      };
      img.onerror = () => reject(new Error("Could not read the picture."));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function complainantContactedValue() {
  if (jobComplainantChoice === "other") {
    const extra = document.getElementById("jobComplainantOther")?.value.trim() || "";
    return extra ? `Other: ${extra}` : "";
  }
  return JOB_COMPLAINANT[jobComplainantChoice] || "";
}

function resetJobClosureForm() {
  const form = document.getElementById("jobClosureForm");
  if (form) form.reset();
  fillJobTimeSelects();
  fillJobReportingSelect();
  jobMediaAttached = "";
  jobCompleteChoice = "";
  jobOutcomeChoice = "";
  jobComplainantChoice = "";
  jobWardChoice = "";
  setChoiceGroup("[data-job-media]", "data-job-media", "");
  setChoiceGroup("[data-job-complete]", "data-job-complete", "");
  setChoiceGroup("[data-job-outcome]", "data-job-outcome", "");
  setChoiceGroup("[data-job-complainant]", "data-job-complainant", "");
  setChoiceGroup("[data-job-ward]", "data-job-ward", "");
  setComplainantOtherVisible(false);
  setJobPhotoAttachVisible(false);
  const date = document.getElementById("jobDate");
  if (date) date.value = todayInputDate();
  const now = new Date();
  const hour = document.getElementById("jobHour");
  const minute = document.getElementById("jobMinute");
  if (hour) hour.value = pad2(now.getHours());
  if (minute) minute.value = pad2(now.getMinutes());
  const officers = document.getElementById("jobOfficers");
  if (officers) officers.value = currentOfficerCode;
  showJobClosureStatus("");
}

function showJobClosureStatus(message, tone) {
  const el = document.getElementById("jobClosureStatus");
  if (!el) return;
  el.classList.remove("ok", "err");
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
  if (tone) el.classList.add(tone);
}

function showJobClosures() {
  resetJobClosureForm();
  showScreen("jobClosures");
}

async function trySaveJobClosure(event) {
  event.preventDefault();
  return;
  const sb = getSupabase();
  if (!sb) {
    showJobClosureStatus("Not signed in.", "err");
    return;
  }
  const attendanceDate = document.getElementById("jobDate").value;
  const attendanceTime = jobAttendanceTime();
  const officers = document.getElementById("jobOfficers").value.trim();
  const complainant = complainantContactedValue();
  const reporting = document.getElementById("jobReporting").value;
  if (!attendanceDate) {
    showJobClosureStatus("Enter the date of attendance.", "err");
    return;
  }
  if (!attendanceTime) {
    showJobClosureStatus("Enter the time of attendance.", "err");
    return;
  }
  if (!officers) {
    showJobClosureStatus("Enter officer surname / officer code.", "err");
    return;
  }
  if (!complainant) {
    showJobClosureStatus(jobComplainantChoice === "other"
      ? "Enter the other complainant contact details."
      : "Choose whether the complainant was contacted.", "err");
    return;
  }
  if (jobWardChoice !== "yes" && jobWardChoice !== "no") {
    showJobClosureStatus("Choose whether the ward office was contacted.", "err");
    return;
  }
  if (!reporting) {
    showJobClosureStatus("Choose a reporting type.", "err");
    return;
  }
  if (jobMediaAttached !== "yes" && jobMediaAttached !== "no") {
    showJobClosureStatus("Choose whether a picture or voice recording is attached.", "err");
    return;
  }
  if (jobCompleteChoice !== "yes" && jobCompleteChoice !== "no") {
    showJobClosureStatus("Choose whether the job is complete.", "err");
    return;
  }
  const outcome = JOB_OUTCOMES[jobOutcomeChoice];
  if (!outcome) {
    showJobClosureStatus("Choose an outcome.", "err");
    return;
  }
  const btn = document.getElementById("jobClosureBtn");
  if (btn) btn.disabled = true;
  showJobClosureStatus("");
  try {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    const user = sessionData?.session?.user;
    if (sessionError || !user) {
      showJobClosureStatus("Sign in again, then save the job.", "err");
      return;
    }
    let photoPath = null;
    const photoFile = jobPhotoFile();
    if (jobMediaAttached === "yes" && photoFile) {
      const blob = await compressJobPhoto(photoFile);
      photoPath = `${user.id}/${Date.now()}.jpg`;
      const { error: uploadError } = await sb.storage.from("job-closures").upload(photoPath, blob, {
        contentType: "image/jpeg",
        upsert: false
      });
      if (uploadError) {
        showJobClosureStatus(uploadError.message || "Could not upload the picture. Run the job-closure photos SQL first.", "err");
        return;
      }
    }
    const payload = {
      user_id: user.id,
      officer_email: user.email || "",
      officer_name: currentDisplayName || officerLabel(user.email || ""),
      attendance_date: attendanceDate,
      attendance_time: attendanceTime,
      location_note: document.getElementById("jobLocation").value.trim() || null,
      officers,
      observations: document.getElementById("jobObservations").value.trim() || null,
      complainant_contacted: complainant,
      ward_office_contact: jobWardChoice,
      media_attached: jobMediaAttached,
      referral: document.getElementById("jobReferral").value.trim() || null,
      reporting,
      job_complete: jobCompleteChoice,
      outcome,
      photo_path: photoPath
    };
    let { error } = await sb.from("job_closures").insert(payload);
    if (error && photoPath && /photo_path/i.test(error.message || "")) {
      delete payload.photo_path;
      const retry = await sb.from("job_closures").insert(payload);
      error = retry.error;
    }
    if (error) {
      showJobClosureStatus(error.message || "Could not save. Run the job-closures SQL first.", "err");
      return;
    }
    resetJobClosureForm();
    showJobClosureStatus("Job closure saved.", "ok");
  } catch (e) {
    showJobClosureStatus("Could not save the job closure.", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function officerLabel(email) {
  const raw = String(email || "").trim();
  if (!raw) return "—";
  return raw.split("@")[0];
}

function officerDisplayName(row) {
  const name = String(row?.officer_name || "").trim();
  if (name) return name;
  return officerLabel(row?.officer_email);
}

let vehicleChargeRows = [];

function chargePctClass(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return "charge-pct";
  if (n >= 75) return "charge-pct charge-pct-high";
  if (n >= 50) return "charge-pct charge-pct-mid";
  if (n >= 25) return "charge-pct charge-pct-low";
  return "charge-pct charge-pct-crit";
}

function vehicleLogQuery() {
  const box = document.getElementById("vehicleLogSearch");
  return String(box?.value || "").trim().toLowerCase();
}

function rowMatchesLogQuery(row, q) {
  if (!q) return true;
  const who = officerDisplayName(row).toLowerCase();
  const hay = [
    formatLocalTimestamp(row.created_at),
    who,
    row.officer_name,
    row.officer_email,
    row.fleet,
    row.vehicle,
    row.location,
    String(row.charge_percent)
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function renderVehicleChargeLog() {
  const host = document.getElementById("vehicleChargeLog");
  if (!host) return;
  if (!vehicleChargeRows.length) {
    host.textContent = "No charge updates yet.";
    return;
  }
  const q = vehicleLogQuery();
  const matched = vehicleChargeRows.filter((row) => rowMatchesLogQuery(row, q));
  if (!matched.length) {
    host.textContent = "No matching updates.";
    return;
  }
  const rows = matched.map((row) => `<tr>
      <td>${esc(formatLocalTimestamp(row.created_at))}</td>
      <td>${esc(officerDisplayName(row))}</td>
      <td>${esc(row.fleet)}</td>
      <td>${esc(row.vehicle)}</td>
      <td class="${chargePctClass(row.charge_percent)}">${esc(row.charge_percent)}%</td>
      <td>${esc(row.location)}</td>
    </tr>`).join("");
  host.innerHTML = `<table class="charge-table">
    <thead><tr>
      <th>When</th><th>Who</th><th>Fleet</th><th>Vehicle</th><th>Charge</th><th>Location</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function loadVehicleCharges() {
  const host = document.getElementById("vehicleChargeLog");
  if (!host) return;
  const sb = getSupabase();
  if (!sb) {
    vehicleChargeRows = [];
    host.textContent = "Not signed in.";
    return;
  }
  host.textContent = "Loading…";
  let { data, error } = await sb
    .from("vehicle_charges")
    .select("created_at, officer_email, officer_name, fleet, vehicle, charge_percent, location")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    const retry = await sb
      .from("vehicle_charges")
      .select("created_at, officer_email, fleet, vehicle, charge_percent, location")
      .order("created_at", { ascending: false })
      .limit(200);
    data = retry.data;
    error = retry.error;
  }
  if (error) {
    vehicleChargeRows = [];
    host.textContent = error.message || "Could not load the charge log.";
    return;
  }
  vehicleChargeRows = data || [];
  renderVehicleChargeLog();
}

async function trySaveVehicleCharge(event) {
  event.preventDefault();
  const sb = getSupabase();
  if (!sb) {
    showVehicleStatus("Not signed in.", "err");
    return;
  }
  const vehicle = document.getElementById("vehicleSelect").value;
  const percent = Number(document.getElementById("chargePercent").value);
  if (!vehicleFleet) {
    showVehicleStatus("Pick TACT or MET.", "err");
    return;
  }
  if (!vehicle) {
    showVehicleStatus("Pick a vehicle.", "err");
    return;
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    showVehicleStatus("Charge must be a whole number from 0 to 100.", "err");
    return;
  }
  if (!vehicleLocation) {
    showVehicleStatus("Pick OCT or GSQ.", "err");
    return;
  }
  const btn = document.getElementById("vehicleChargeBtn");
  if (btn) btn.disabled = true;
  showVehicleStatus("");
  try {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    const user = sessionData?.session?.user;
    if (sessionError || !user) {
      showVehicleStatus("Sign in again, then save the charge.", "err");
      return;
    }
    const { error } = await sb.from("vehicle_charges").insert({
      user_id: user.id,
      officer_email: user.email || "",
      officer_name: currentDisplayName || officerLabel(user.email || ""),
      fleet: vehicleFleet,
      vehicle,
      charge_percent: percent,
      location: vehicleLocation
    });
    if (error) {
      showVehicleStatus(error.message || "Could not save. Check the database is set up.", "err");
      return;
    }
    document.getElementById("vehicleChargeForm").reset();
    vehicleFleet = "";
    vehicleLocation = "";
    setChoiceGroup("[data-fleet]", "data-fleet", "");
    setChoiceGroup("[data-location]", "data-location", "");
    fillVehicleSelect();
    showVehicleStatus("Charge saved.", "ok");
    loadVehicleCharges();
  } catch (e) {
    showVehicleStatus("Could not save. Check your connection.", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
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

let authClient = null;
let uiBound = false;
let appStarted = false;
let currentRole = "officer";
let currentDisplayName = "";
let currentOfficerCode = "";
let signedInEmail = "";
let newOfficerRole = "officer";

function canViewChargeLog() {
  return currentRole === "roc" || currentRole === "admin";
}

function isAdmin() {
  return currentRole === "admin";
}

function roleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "roc") return "ROC";
  return "Officer";
}

async function loadProfile(userId) {
  currentRole = "officer";
  currentDisplayName = "";
  currentOfficerCode = "";
  const sb = getSupabase();
  if (!sb || !userId) return;
  try {
    let { data, error } = await sb.from("profiles").select("role, display_name, officer_code").eq("id", userId).maybeSingle();
    if (error) {
      const retry = await sb.from("profiles").select("role, display_name").eq("id", userId).maybeSingle();
      data = retry.data;
    }
    if (data?.role === "officer" || data?.role === "roc" || data?.role === "admin") {
      currentRole = data.role;
    }
    currentDisplayName = String(data?.display_name || "").trim();
    currentOfficerCode = String(data?.officer_code || "").trim();
  } catch (e) {
    currentRole = "officer";
    currentDisplayName = "";
    currentOfficerCode = "";
  }
}

function applyRoleUi() {
  const addBtn = document.getElementById("openAddOfficer");
  if (addBtn) addBtn.classList.toggle("hidden", !isAdmin());
  const log = document.getElementById("vehicleLogSection");
  if (log) log.classList.toggle("hidden", !canViewChargeLog());
}

function getSupabase() {
  if (authClient) return authClient;
  const url = String(window.PEAK_SUPABASE_URL || "").trim();
  const key = String(window.PEAK_SUPABASE_ANON_KEY || "").trim();
  const lib = window.supabase;
  if (!url || !key || !lib || typeof lib.createClient !== "function") return null;
  authClient = lib.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  return authClient;
}

function showLockError(message) {
  const el = document.getElementById("lockError");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function renderSignedIn(email) {
  if (arguments.length) signedInEmail = email || "";
  const el = document.getElementById("signedInAs");
  if (!el) return;
  const who = currentDisplayName || signedInEmail;
  el.textContent = who ? `Signed in as ${who} (${roleLabel(currentRole)})` : "";
}

function unlockApp() {
  document.body.classList.remove("locked");
  const lock = document.getElementById("lockScreen");
  if (lock) lock.classList.add("hidden");
}

function lockApp() {
  document.body.classList.add("locked");
  const lock = document.getElementById("lockScreen");
  if (lock) lock.classList.remove("hidden");
  currentDisplayName = "";
  currentOfficerCode = "";
  signedInEmail = "";
  renderSignedIn("");
  const pwd = document.getElementById("accessPassword");
  if (pwd) pwd.value = "";
  const changeForm = document.getElementById("changePasswordForm");
  if (changeForm) changeForm.reset();
  showChangePasswordStatus("");
  const addForm = document.getElementById("addOfficerForm");
  if (addForm) addForm.reset();
  newOfficerRole = "officer";
  setChoiceGroup("[data-new-role]", "data-new-role", "officer");
  showAddOfficerStatus("");
  resetJobClosureForm();
  currentRole = "officer";
  applyRoleUi();
}

async function enterApp(session) {
  await loadProfile(session?.user?.id);
  applyRoleUi();
  unlockApp();
  renderSignedIn(session?.user?.email || "");
  if (!appStarted) {
    appStarted = true;
    await startApp();
    return;
  }
  showHome();
}

async function trySignIn(event) {
  event.preventDefault();
  const sb = getSupabase();
  if (!sb) {
    showLockError("Login is not configured yet. Add the Supabase URL and anon key.");
    return;
  }
  const email = document.getElementById("accessEmail").value.trim();
  const password = document.getElementById("accessPassword").value;
  const btn = document.getElementById("unlockBtn");
  showLockError("");
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showLockError("Email or password is incorrect.");
      const pwd = document.getElementById("accessPassword");
      if (pwd) {
        pwd.value = "";
        pwd.focus();
      }
      return;
    }
    await enterApp(data.session);
  } catch (e) {
    showLockError("Could not sign in. Check your connection and try again.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function signOut() {
  const sb = getSupabase();
  if (sb) {
    try { await sb.auth.signOut(); } catch (e) { /* stay locked even if this fails */ }
  }
  lockApp();
  const email = document.getElementById("accessEmail");
  if (email) email.focus();
}

function showChangePasswordStatus(message, tone) {
  const el = document.getElementById("changePasswordStatus");
  if (!el) return;
  el.classList.remove("ok", "err");
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
  if (tone) el.classList.add(tone);
}

async function tryChangePassword(event) {
  event.preventDefault();
  const sb = getSupabase();
  if (!sb) {
    showChangePasswordStatus("Not signed in.", "err");
    return;
  }
  const current = document.getElementById("currentPassword").value;
  const next = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmPassword").value;
  if (next.length < 8) {
    showChangePasswordStatus("New password must be at least 8 characters.", "err");
    return;
  }
  if (next !== confirm) {
    showChangePasswordStatus("New passwords do not match.", "err");
    return;
  }
  if (next === current) {
    showChangePasswordStatus("Choose a different password from the current one.", "err");
    return;
  }
  const btn = document.getElementById("changePasswordBtn");
  if (btn) btn.disabled = true;
  showChangePasswordStatus("");
  try {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    const email = sessionData?.session?.user?.email;
    if (sessionError || !email) {
      showChangePasswordStatus("Sign in again, then try changing your password.", "err");
      return;
    }
    const { error: checkError } = await sb.auth.signInWithPassword({ email, password: current });
    if (checkError) {
      showChangePasswordStatus("Current password is incorrect.", "err");
      return;
    }
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) {
      showChangePasswordStatus(error.message || "Could not update password.", "err");
      return;
    }
    document.getElementById("changePasswordForm").reset();
    showChangePasswordStatus("Password updated. Use the new one next time you sign in.", "ok");
  } catch (e) {
    showChangePasswordStatus("Could not update password. Check your connection.", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindLockUi() {
  const form = document.getElementById("lockForm");
  if (form) form.addEventListener("submit", trySignIn);
}

function bindUi() {
  if (uiBound) return;
  uiBound = true;
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
  document.getElementById("openVehicles").onclick = showVehicles;
  const openJobs = document.getElementById("openJobClosures");
  if (openJobs) openJobs.onclick = showJobClosures;
  document.querySelectorAll("[data-job-complainant]").forEach((btn) => {
    btn.onclick = () => {
      jobComplainantChoice = btn.getAttribute("data-job-complainant") || "";
      setChoiceGroup("[data-job-complainant]", "data-job-complainant", jobComplainantChoice);
      setComplainantOtherVisible(jobComplainantChoice === "other");
    };
  });
  document.querySelectorAll("[data-job-ward]").forEach((btn) => {
    btn.onclick = () => {
      jobWardChoice = btn.getAttribute("data-job-ward") || "";
      setChoiceGroup("[data-job-ward]", "data-job-ward", jobWardChoice);
    };
  });
  document.querySelectorAll("[data-job-media]").forEach((btn) => {
    btn.onclick = () => {
      jobMediaAttached = btn.getAttribute("data-job-media") || "";
      setChoiceGroup("[data-job-media]", "data-job-media", jobMediaAttached);
      setJobPhotoAttachVisible(jobMediaAttached === "yes");
    };
  });
  const jobPhoto = document.getElementById("jobPhoto");
  const jobPhotoCamera = document.getElementById("jobPhotoCamera");
  const jobPhotoPick = document.getElementById("jobPhotoPick");
  const jobPhotoTake = document.getElementById("jobPhotoTake");
  if (jobPhotoPick && jobPhoto) {
    jobPhotoPick.onclick = () => {
      if (jobPhotoCamera) jobPhotoCamera.value = "";
      jobPhoto.click();
    };
  }
  if (jobPhotoTake && jobPhotoCamera) {
    jobPhotoTake.onclick = () => {
      if (jobPhoto) jobPhoto.value = "";
      jobPhotoCamera.click();
    };
  }
  if (jobPhoto) {
    jobPhoto.addEventListener("change", () => {
      if (jobPhotoCamera) jobPhotoCamera.value = "";
      showJobPhotoPreview(jobPhoto.files?.[0]);
    });
  }
  if (jobPhotoCamera) {
    jobPhotoCamera.addEventListener("change", () => {
      if (jobPhoto) jobPhoto.value = "";
      showJobPhotoPreview(jobPhotoCamera.files?.[0]);
    });
  }
  const jobPhotoClear = document.getElementById("jobPhotoClear");
  if (jobPhotoClear) jobPhotoClear.onclick = clearJobPhoto;
  document.querySelectorAll("[data-job-complete]").forEach((btn) => {
    btn.onclick = () => {
      jobCompleteChoice = btn.getAttribute("data-job-complete") || "";
      setChoiceGroup("[data-job-complete]", "data-job-complete", jobCompleteChoice);
    };
  });
  document.querySelectorAll("[data-job-outcome]").forEach((btn) => {
    btn.onclick = () => {
      jobOutcomeChoice = btn.getAttribute("data-job-outcome") || "";
      setChoiceGroup("[data-job-outcome]", "data-job-outcome", jobOutcomeChoice);
    };
  });
  const jobForm = document.getElementById("jobClosureForm");
  if (jobForm) jobForm.addEventListener("submit", trySaveJobClosure);
  document.querySelectorAll("[data-fleet]").forEach((btn) => {
    btn.onclick = () => setVehicleFleet(btn.getAttribute("data-fleet"));
  });
  document.querySelectorAll("[data-location]").forEach((btn) => {
    btn.onclick = () => setVehicleLocation(btn.getAttribute("data-location"));
  });
  const vehicleForm = document.getElementById("vehicleChargeForm");
  if (vehicleForm) vehicleForm.addEventListener("submit", trySaveVehicleCharge);
  const refreshLog = document.getElementById("refreshVehicleLog");
  if (refreshLog) refreshLog.onclick = loadVehicleCharges;
  const logSearch = document.getElementById("vehicleLogSearch");
  if (logSearch) logSearch.addEventListener("input", renderVehicleChargeLog);
  document.getElementById("refreshRoutes").onclick = refreshRouteData;
  document.getElementById("sortNearest").onclick = () => setSortMode("nearest");
  document.getElementById("sortRecommended").onclick = () => setSortMode("route");
  const signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) signOutBtn.onclick = signOut;
  const openChange = document.getElementById("openChangePassword");
  if (openChange) openChange.onclick = showChangePassword;
  const openAdd = document.getElementById("openAddOfficer");
  if (openAdd) openAdd.onclick = showAddOfficer;
  const addForm = document.getElementById("addOfficerForm");
  if (addForm) addForm.addEventListener("submit", tryAddOfficer);
  document.querySelectorAll("[data-new-role]").forEach((btn) => {
    btn.onclick = () => {
      newOfficerRole = btn.getAttribute("data-new-role") || "officer";
      setChoiceGroup("[data-new-role]", "data-new-role", newOfficerRole);
    };
  });
  const changeForm = document.getElementById("changePasswordForm");
  if (changeForm) changeForm.addEventListener("submit", tryChangePassword);
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

async function bootAuth() {
  bindLockUi();
  const sb = getSupabase();
  if (!sb) {
    showLockError("Login is not configured yet. Add the Supabase URL and anon key.");
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) {
    await enterApp(data.session);
    return;
  }
  const email = document.getElementById("accessEmail");
  if (email) email.focus();
}

bootAuth();

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
