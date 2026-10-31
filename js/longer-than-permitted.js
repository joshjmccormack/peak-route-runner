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
    { minutes: 5, label: "5 min" },
    { minutes: 10, label: "10 min" },
    { minutes: 15, label: "15 min" },
    { minutes: 20, label: "20 min" },
    { minutes: 30, label: "30 min" },
    { minutes: 35, label: "35 min" },
    { minutes: 45, label: "45 min" },
    { minutes: 60, label: "1 h" },
    { minutes: 90, label: "1.5 h" },
    { minutes: 120, label: "2 h" },
    { minutes: 180, label: "3 h" },
    { minutes: 240, label: "4 h" }
  ];

  let locations = [];
  let tickId = 0;
  let bound = false;
  let saving = false;
  let notifyAsked = false;

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
      next.push({
        id,
        label,
        lat,
        lng,
        accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
        savedAt: typeof item.savedAt === "string" ? item.savedAt : "",
        timerEnd: Number.isFinite(timerEnd) ? timerEnd : null,
        durationMinutes: Number.isInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : null,
        alerted: item.alerted === true
      });
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
      const cancel = row.querySelector("[data-action='cancel']");
      if (cancel) cancel.classList.toggle("hidden", !running);
      const restart = row.querySelector("[data-action='restart']");
      if (restart) restart.classList.toggle("hidden", !loc.durationMinutes);
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
      const labelId = `ltp-label-${loc.id}`;
      const customId = `ltp-custom-${loc.id}`;
      return `<article class="ltp-row${overdue ? " ltp-overdue" : ""}" data-id="${esc(loc.id)}">
        <div class="ltp-head">
          <label class="hidden" for="${esc(labelId)}">Label</label>
          <input id="${esc(labelId)}" class="ltp-label" type="text" maxlength="80" value="${esc(loc.label)}" autocomplete="off">
          <button type="button" class="danger small" data-action="delete">Delete</button>
        </div>
        <p class="muted ltp-meta">${esc(formatSavedAt(loc.savedAt))} · ${esc(formatCoord(loc.lat))}, ${esc(formatCoord(loc.lng))} · ${esc(formatAccuracy(loc.accuracy))}</p>
        <p class="ltp-clock${clock ? "" : " hidden"}">${esc(clock)}</p>
        <div class="field-label">Timer</div>
        <div class="ltp-presets">${presetButtons()}</div>
        <div class="ltp-custom">
          <label class="hidden" for="${esc(customId)}">Custom minutes</label>
          <input id="${esc(customId)}" class="ltp-custom-minutes" type="number" inputmode="numeric" min="1" max="${MAX_MINUTES}" step="1" placeholder="Minutes">
          <button type="button" class="secondary" data-action="custom">Start</button>
        </div>
        <p class="ltp-row-msg change-password-status err hidden"></p>
        <div class="ltp-actions">
          <button type="button" class="secondary${running ? "" : " hidden"}" data-action="cancel">Cancel timer</button>
          <button type="button" class="secondary${loc.durationMinutes ? "" : " hidden"}" data-action="restart">Restart</button>
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

  function restartTimer(id) {
    const loc = findLoc(id);
    if (!loc || !loc.durationMinutes) return;
    startTimer(id, loc.durationMinutes);
  }

  function parseCustomMinutes(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    if (!/^\d+$/.test(text)) return Number.NaN;
    return Number(text);
  }

  function startCustom(row) {
    const id = row.getAttribute("data-id");
    const input = row.querySelector(".ltp-custom-minutes");
    const minutes = parseCustomMinutes(input && input.value);
    if (!validMinutes(minutes)) {
      setRowMessage(id, `Enter whole minutes from 1 to ${MAX_MINUTES}.`);
      return;
    }
    startTimer(id, minutes);
  }

  function deleteLocation(id) {
    const loc = findLoc(id);
    if (!loc) return;
    const name = loc.label || "this location";
    if (typeof window.confirm === "function" && !window.confirm(`Delete ${name}?`)) return;
    locations = locations.filter((item) => item.id !== id);
    persist();
    renderList();
    syncTicker();
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
    if (action === "custom") {
      startCustom(row);
      return;
    }
    if (action === "cancel") {
      cancelTimer(id);
      return;
    }
    if (action === "restart") {
      restartTimer(id);
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

  function onListInput(event) {
    const input = event.target.closest(".ltp-label");
    if (!input) return;
    const row = input.closest(".ltp-row");
    if (!row) return;
    const loc = findLoc(row.getAttribute("data-id"));
    if (!loc) return;
    const value = input.value.slice(0, 80);
    if (!value.trim()) return;
    loc.label = value;
    persist();
  }

  function onListBlur(event) {
    const input = event.target.closest && event.target.closest(".ltp-label");
    if (!input) return;
    const row = input.closest(".ltp-row");
    if (!row) return;
    const loc = findLoc(row.getAttribute("data-id"));
    if (!loc) return;
    const value = input.value.replace(/\s+/g, " ").trim().slice(0, 80);
    loc.label = value || "Location";
    input.value = loc.label;
    persist();
  }

  function onListKeydown(event) {
    if (event.key !== "Enter") return;
    const input = event.target.closest(".ltp-custom-minutes");
    if (!input) return;
    const row = input.closest(".ltp-row");
    if (!row) return;
    event.preventDefault();
    startCustom(row);
  }

  function bind() {
    if (bound || typeof document === "undefined") return;
    bound = true;
    const saveBtn = el("ltpSaveLocation");
    if (saveBtn) saveBtn.addEventListener("click", saveMyLocation);
    const list = el("ltpList");
    if (list) {
      list.addEventListener("click", onListClick);
      list.addEventListener("input", onListInput);
      list.addEventListener("keydown", onListKeydown);
      list.addEventListener("focusout", onListBlur);
    }
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
    clockText
  };
  root.PinLongerThanPermitted = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") boot();
})(typeof window !== "undefined" ? window : globalThis);
