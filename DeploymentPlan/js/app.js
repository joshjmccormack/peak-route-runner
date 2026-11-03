import {
  addDays,
  formatDayHeading,
  formatDayShort,
  formatWeekRange,
  isValidISODate,
  mondayOf,
  sydneyToday,
  weekDates,
} from "./dates.js";
import { areaLabel, areaTone, peakAndArea } from "./cells.js";
import { comparePlanLines, exemptFromSignOn, lateMarkerCleared, reminderKey, shiftStartMinutes, signOnState, sydneyClockMinutes } from "./late.js";
import { dayCellPaint, groupPlanLines, matchesRosterQuery, officerDayTarget } from "./line.js";

const { createClient } = window.supabase || {};

const SECTIONS = [
  { id: "FS", title: "Field Supervisors" },
  { id: "SST", title: "Suburban Safety Team" },
  { id: "Parking", title: "Parking Compliance" },
  { id: "ROC", title: "ROC Coordinators" },
  { id: "SLG", title: "Senior Leadership" },
  { id: "After hours", title: "After hours" },
  { id: "Other", title: "Other" },
];

const SECTION_IDS = new Set(SECTIONS.map((section) => section.id));

const STATUS_LABEL = {
  draft: "Draft",
  published: "Published",
  leave: "Leave",
  ot: "Overtime",
  stood_down: "STOOD DOWN",
  sick: "Sick",
};

const PRESENCE = {
  online: { label: "Online", short: "Online" },
  admin_oct: { label: "Office", short: "Office" },
  lunch: { label: "Lunch", short: "Lunch" },
  offline: { label: "Offline", short: "Offline" },
  end: { label: "Finished", short: "Finished" },
};

const SIGN_ON_STATUSES = ["online", "admin_oct"];
const PRESENCE_ORDER = ["online", "admin_oct", "lunch", "offline", "end"];
const FALLBACK = {
  shift: ["0630-1500", "0730-1600", "1030-1900", "1400-2330", "1430-2300", "1500-1900", "1600-1900", "1900-2300", "0630-1030"],
  function: ["FS", "SST", "TACT", "MET", "HB1", "HB2", "OS", "TL", "BM", "ROC", "SROC", "TRAINEE", "PCTO", "EVENT", "VMC", "AFTER HOURS"],
  task: ["1&2", "3", "4", "4&5", "5", "6", "7", "3,6&7", "6&7", "OCT", "OFFICE", "PAIRED"],
  peak: ["1&2", "3", "4", "4&5", "5", "6", "7", "3,6&7", "6&7", "OCT", "OFFICE"],
  area: ["NORTH", "SOUTH", "EAST", "WEST", "CENTRAL", "NORTH A", "NORTH B", "CENTRAL A", "CENTRAL B", "EAST A", "EAST B", "SOUTH A", "SOUTH B", "WEST A", "WEST B", "RUN A", "RUN B", "RUN C", "RUN D", "MET 1", "MET 2", "MET 3", "MET 4", "GABBA", "LPTA", "TENNYSON", "ALL COMPLAINTS"],
};

const LOOKUP_ALIASES = {
  shift: ["shift", "shifts"],
  function: ["function", "functions"],
  task: ["task", "tasks"],
  area: ["area", "areas", "run"],
};

const state = {
  config: null,
  user: null,
  profile: null,
  weekStart: null,
  view: "my-week",
  focusDay: null,
  focusOffset: 0,
  statusFilter: "all",
  planSpan: "weekday",
  density: "compact",
  assignments: [],
  officers: [],
  fleet: [],
  lists: structuredClone(FALLBACK),
  usingFallback: true,
  loading: false,
  error: "",
  deniedPlan: false,
  board: "live",
  weekMeta: null,
  dispatchers: {},
  officerQuery: "",
  planQuery: "",
  officerFilter: "active",
  signOnExemptCodes: new Set(),
  officerDraft: null,
  editingId: null,
  lastFocus: null,
  unread: new Set(),
  presence: {},
};

const cellEditor = {
  open: false,
  id: null,
  snapshot: "",
  saving: false,
  anchor: null,
  next: null,
  lastDate: "",
};

let supabase = null;
let rosterChannel = null;
let presenceChannel = null;
let loadSeq = 0;
let presenceSeq = 0;
let presenceTimer = 0;
const presenceMenu = { code: "", line: "" };
let toastTimer = 0;
let enteredFor = null;
let reloadTimer = 0;
let reloadQueued = false;
let localEchoUntil = 0;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function currentRole() {
  return state.profile?.role || "officer";
}

function isRosterEditor() {
  const role = currentRole();
  return role === "admin" || role === "slg";
}

function isStatusEditor() {
  return isRosterEditor() || currentRole() === "dispatch";
}

function isOfficerAdmin() {
  return isRosterEditor();
}

function isOt(row) {
  return !!(row && (row.is_ot || row.status === "ot"));
}

function thisMonday() {
  return mondayOf(sydneyToday());
}

function isLiveWeek(weekStart) {
  const start = thisMonday();
  return weekStart === start || weekStart === addDays(start, 7);
}

function metaArchived(meta) {
  if (!meta?.archived_at) return false;
  if (meta.restored_at && meta.restored_at > meta.archived_at) return false;
  return true;
}

function weekLocked() {
  if (!state.weekStart) return false;
  if (metaArchived(state.weekMeta)) return true;
  if (state.weekMeta?.restored_at && (!state.weekMeta.archived_at || state.weekMeta.restored_at > state.weekMeta.archived_at)) {
    return false;
  }
  return state.weekStart < thisMonday();
}

function roleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "slg") return "SLG";
  if (role === "dispatch") return "Dispatch";
  if (role === "roc") return "ROC";
  return "Officer";
}

function friendlyError(error) {
  const msg = error?.message || "Something went wrong.";
  if (/row-level security|permission denied|42501/i.test(msg) || error?.code === "42501") {
    return "You don’t have permission for that change.";
  }
  if (/check constraint|23514/i.test(msg) || error?.code === "23514") {
    return "That section or status isn’t one of the allowed values.";
  }
  if (/Failed to fetch|NetworkError|network/i.test(msg)) {
    return "Can’t reach the Parking Project just now. Check the connection and try again.";
  }
  return msg;
}

function toast(message, { duration = 2800, notice = false } = {}) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("notice", notice);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.textContent = "";
    el.classList.remove("notice");
  }, duration);
}

function beginLocalEcho() {
  localEchoUntil = Date.now() + 4000;
}

function isLocalEcho() {
  return Date.now() < localEchoUntil;
}

function show(id, on) {
  $(id).hidden = !on;
}

async function loadConfig() {
  try {
    const local = await import("./config.js");
    if (local.default?.supabaseUrl && local.default?.supabaseAnonKey) {
      return { ...local.default, source: "config.js" };
    }
  } catch {
    /* local override is optional */
  }
  const example = await import("./config.example.js");
  if (example.default?.supabaseUrl && example.default?.supabaseAnonKey) {
    return { ...example.default, source: "config.example.js" };
  }
  return null;
}

function readRoute() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw || raw.includes("access_token=") || raw.startsWith("error") || raw.startsWith("error_description")) {
    return { view: "my-week", week: null };
  }
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const week = params.get("week");
  const day = params.get("day");
  const view = path === "plan" ? "plan" : path === "day" ? "day" : path === "officers" ? "officers" : "my-week";
  return {
    view,
    week: isValidISODate(week || "") ? mondayOf(week) : null,
    day: isValidISODate(day || "") ? day : null,
  };
}

function writeRoute(replace) {
  const day = state.view === "day" ? `&day=${selectedDay()}` : "";
  const next = state.view === "officers" ? "#officers" : `#${state.view}?week=${state.weekStart}${day}`;
  if (location.hash === next) return;
  if (replace) history.replaceState(null, "", next);
  else location.hash = next;
}

function officerById(id) {
  return state.officers.find((officer) => officer.id === id) || null;
}

function officerByCode(code) {
  if (!code) return null;
  return state.officers.find((officer) => officer.code === code) || null;
}

function personName(row) {
  const officer = officerById(row.officer_id) || officerByCode(row.officer_code);
  if (officer?.name) return officer.name;
  if (row.officer_code) return row.officer_code;
  return "Vacant";
}

function officerLabel(row) {
  const officer = officerById(row.officer_id) || officerByCode(row.officer_code);
  if (officer) return `${officer.name} · ${officer.code}`;
  if (row.officer_code) return row.officer_code;
  return "Vacant";
}

function formatShift(shift) {
  if (!shift) return "Shift not set";
  return String(shift).replace(/\s*-\s*/g, "–");
}

function passesFilter(row) {
  if (state.statusFilter === "all") return true;
  return row.status === state.statusFilter;
}

function searchFieldsForRow(row) {
  const officer = officerById(row.officer_id) || officerByCode(row.officer_code);
  const placed = peakAndArea(row.peak, row.area);
  return [
    officer?.name,
    personName(row),
    officer?.code,
    row.officer_code,
    officer?.radio,
    row.vehicle_id,
    row.shift,
    row.area,
    areaLabel(row.area),
    areaLabel(placed.area),
    row.peak,
    placed.peak,
    row.function,
  ];
}

function groupMatchesSearch(group) {
  const fields = [];
  for (const items of group.byDay.values()) {
    for (const row of items) fields.push(...searchFieldsForRow(row));
  }
  return matchesRosterQuery(state.planQuery, fields);
}

function rowsForView() {
  if (state.view === "plan" || state.view === "day") return state.assignments;
  const code = state.profile?.officer_code;
  if (!code) return [];
  return state.assignments.filter((row) => row.officer_code === code);
}

function sortRows(rows) {
  return [...rows].sort((a, b) => comparePlanLines(
    { shift: a.shift, name: personName(a), ot: isOt(a), id: a.id },
    { shift: b.shift, name: personName(b), ot: isOt(b), id: b.id },
  ));
}

function cardHtml(row) {
  const status = row.status || "draft";
  const otCard = isOt(row);
  const unread = state.unread.has(row.id);
  const bits = [];
  if (row.vehicle_id) bits.push(`Vehicle ${row.vehicle_id}`);
  if (row.peak) bits.push(`Peak ${row.peak}`);
  if (row.area) bits.push(row.area);
  const fn = row.function ? escapeHtml(row.function) : "";
  return `
    <button type="button" class="card status-${escapeHtml(otCard ? "ot" : status)}${unread ? " is-unread" : ""}" data-open="${escapeHtml(row.id)}" data-section="${escapeHtml(row.section)}">
      <div class="card-top">
        <span class="shift">${escapeHtml(formatShift(row.shift))}</span>
        <span class="badge-row">
          ${unread ? `<span class="badge updated">Updated</span>` : ""}
          <span class="badge ${escapeHtml(otCard ? "ot" : status)}">${escapeHtml(otCard ? "Overtime" : (STATUS_LABEL[status] || status))}</span>
        </span>
      </div>
      <div class="who-line">${escapeHtml(officerLabel(row))}</div>
      ${fn ? `<div class="detail">${fn}</div>` : ""}
      ${bits.length ? `<div class="detail">${escapeHtml(bits.join(" · "))}</div>` : ""}
      ${row.notes ? `<div class="notes">${escapeHtml(row.notes)}</div>` : ""}
    </button>`;
}

function renderChrome() {
  const profile = state.profile;
  const name = profile?.display_name || state.user?.email || "Signed in";
  $("who-name").textContent = name;
  const code = profile?.officer_code ? `Code ${profile.officer_code}` : "No officer code";
  $("who-meta").textContent = `${roleLabel(profile?.role)} · ${code}`;
  $("tab-officers").hidden = !isOfficerAdmin();
  $("tab-mine").classList.toggle("is-active", state.view === "my-week");
  $("tab-day").classList.toggle("is-active", state.view === "day");
  $("tab-plan").classList.toggle("is-active", state.view === "plan");
  $("tab-officers").classList.toggle("is-active", state.view === "officers");
  const grid = state.view === "plan" || state.view === "day";
  const editing = plannerGrid();
  const directory = state.view === "officers";
  document.body.classList.toggle("is-plan", grid);
  const spanToggle = $("span-toggle");
  const thisWeek = $("this-week");
  if (spanToggle && thisWeek && spanToggle.previousElementSibling !== thisWeek) thisWeek.after(spanToggle);
  $("week-nav").hidden = directory;
  $("filters").hidden = !grid;
  $("plan-search").hidden = !grid;
  const planQuery = $("plan-query");
  if (planQuery && planQuery.value !== state.planQuery) planQuery.value = state.planQuery;
  $("plan-query-clear").hidden = !state.planQuery.trim();
  spanToggle.hidden = state.view !== "plan";
  $("density-toggle").hidden = !grid;
  $("add-assignment").hidden = !editing || weekLocked();
  $("board-toggle").hidden = !editing;
  $("archive-week").hidden = true;
  $("restore-week").hidden = !editing || !weekLocked();
  document.querySelectorAll("[data-board]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.board === state.board);
  });
  const liveBoard = state.board !== "archive";
  $("prev-week").disabled = false;
  $("next-week").disabled = grid && liveBoard && state.weekStart === addDays(thisMonday(), 7);
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.statusFilter);
  });
  document.querySelectorAll("[data-span]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.span === state.planSpan);
  });
  document.querySelectorAll("[data-density]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.density === state.density);
  });
  const end = addDays(state.weekStart, 6);
  const prefix = state.board === "archive" && editing ? "Archived · " : "";
  $("week-label").textContent = `${prefix}${formatWeekRange(state.weekStart, end)}`;
  ensureFormCopyDays();
}

function notifyPromptVisible() {
  if (isRosterEditor() || state.view !== "my-week") return false;
  if (typeof Notification === "undefined" || Notification.permission !== "default") return false;
  try {
    return localStorage.getItem("roster-notify") !== "dismissed";
  } catch {
    return true;
  }
}

function bannerHtml() {
  const bits = [];
  if (state.deniedPlan) {
    bits.push(`<div class="banner warn">That page is limited to admin and SLG.</div>`);
  }
  if (!state.profile?.officer_code && state.view !== "plan") {
    bits.push(`<div class="banner warn">Your profile has no officer code, so My week cannot match shifts. Ask a planner to set the code on your profile.</div>`);
  }
  if (notifyPromptVisible()) {
    bits.push(`<div class="banner warn notice-ask"><p>Allow notices on this phone for shift changes, and for a reminder if you have not signed on 20 minutes after your shift starts. You can say no.</p><div class="modal-actions"><button type="button" class="primary" data-notify-allow>Allow notices</button><button type="button" class="ghost" data-notify-dismiss>Not now</button></div></div>`);
  }
  if (plannerGrid() && weekLocked()) {
    bits.push(`<div class="banner warn">This week is archived and read-only. Weeks whose Sunday is before today are archived automatically. Restore the week to edit it.</div>`);
  } else if (plannerGrid() && state.board === "archive") {
    bits.push(`<div class="banner ok">This past week is restored. Edit it here, then archive it again when the changes are done.</div>`);
  }
  if (state.error) {
    bits.push(`<div class="banner error">${escapeHtml(state.error)} <button type="button" class="text-btn" data-retry>Try again</button></div>`);
  }
  return bits.join("");
}

function presenceUnlocked(row) {
  const raw = row?.online_unlocked_on;
  if (!raw) return false;
  return String(raw).slice(0, 10) === sydneyToday();
}

function presenceOf(code, lineKey) {
  const line = String(lineKey || "");
  const row = code && line ? state.presence[code]?.[line] : null;
  const unlocked = presenceUnlocked(row);
  const stored = row && PRESENCE[row.status] ? row.status : "offline";
  const status = unlocked ? stored : "offline";
  return {
    status,
    stored,
    unlocked,
    note: row?.note || "",
    lineKey: line,
    label: PRESENCE[status].label,
    short: PRESENCE[status].short,
  };
}

function presenceIds(unlocked) {
  return unlocked ? PRESENCE_ORDER : SIGN_ON_STATUSES;
}

function presenceBar(code, lineKey, heading = "Radio status") {
  if (!code || !lineKey) return "";
  const current = presenceOf(code, lineKey);
  const waiting = !current.unlocked;
  const buttons = presenceIds(current.unlocked).map((id) => {
    const meta = PRESENCE[id];
    const active = id === current.status;
    const locked = waiting && !isStatusEditor();
    return `<button type="button" class="presence-choice presence-${id}${active ? " is-active" : ""}" data-set-presence="${id}" data-line="${escapeHtml(lineKey)}" aria-pressed="${active ? "true" : "false"}"${locked ? " disabled" : ""}>${escapeHtml(meta.label)}</button>`;
  }).join("");
  const lock = waiting
    ? `<p class="presence-lock">${isStatusEditor() ? "Sign on as Online or Office." : "Radio dispatch signs you on as Online or Office."}</p>`
    : "";
  return `
    <div class="presence-bar">
      <div class="presence-label">${escapeHtml(heading)}</div>
      <div class="presence-choices" role="group" aria-label="${escapeHtml(heading)}">${buttons}</div>
      ${lock}
      <input class="presence-note" data-presence-note data-line="${escapeHtml(lineKey)}" maxlength="200" placeholder="Note for the board, optional" value="${escapeHtml(current.note)}" autocomplete="off">
    </div>`;
}

function presenceBarsForMine(rows) {
  const today = sydneyToday();
  const groups = [...groupPlanLines(rows.filter((row) => row.work_date === today)).values()];
  if (!groups.length) return `<p class="quiet">No shift to sign on today.</p>`;
  return groups.map((group) => {
    const heading = `${isOt(group.sample) ? "Overtime" : "Shift"} ${formatShift(group.sample.shift)}`;
    return presenceBar(group.sample.officer_code, group.lineKey, heading);
  }).join("");
}

function presenceChip(code, lineKey, late) {
  if (!code) return "";
  const current = presenceOf(code, lineKey);
  const line = lineKey ? ` data-line="${escapeHtml(lineKey)}"` : "";
  if (late) {
    const title = ["LATE", current.note].filter(Boolean).join(" · ");
    return `<button type="button" class="presence presence-late" data-presence="${escapeHtml(code)}"${line} title="${escapeHtml(title)}" aria-label="LATE">LATE</button>`;
  }
  const title = [current.label, current.note].filter(Boolean).join(" · ");
  return `<button type="button" class="presence presence-${current.status}" data-presence="${escapeHtml(code)}"${line} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${escapeHtml(current.short)}</button>`;
}

function renderMine(rows) {
  const today = sydneyToday();
  const days = weekDates(state.weekStart);
  const mine = sortRows(rows);
  const code = state.profile?.officer_code;
  const self = officerByCode(code);
  const contact = self?.contact || "";
  const tel = contact.replace(/[^\d+]/g, "");
  const contactHtml = tel.length >= 8
    ? `<a href="tel:${escapeHtml(tel)}">${escapeHtml(contact)}</a>`
    : escapeHtml(contact || "—");

  const strip = `
    <div class="person-strip">
      <div><strong>${escapeHtml(state.profile?.display_name || "You")}</strong></div>
      <div>Code <strong>${escapeHtml(code || "not set")}</strong></div>
      ${self?.radio ? `<div>Radio <strong>${escapeHtml(self.radio)}</strong></div>` : ""}
      ${contact ? `<div>Contact ${contactHtml}</div>` : ""}
      <div class="quiet">${mine.length} shift${mine.length === 1 ? "" : "s"} this week</div>
      ${presenceBarsForMine(mine)}
    </div>`;

  if (!mine.length && !state.loading) {
    return `${strip}
      <div class="empty">
        <h2>No shifts this week</h2>
        <p>Nothing is assigned to code ${escapeHtml(code || "your profile")} between ${escapeHtml(formatWeekRange(state.weekStart, addDays(state.weekStart, 6)))}.</p>
      </div>`;
  }

  const blocks = days.map((iso) => {
    const dayRows = mine.filter((row) => row.work_date === iso);
    const body = dayRows.length
      ? `<div class="my-cards">${dayRows.map(cardHtml).join("")}</div>`
      : `<p class="quiet">No shift</p>`;
    return `
      <section class="day-block${iso === today ? " is-today" : ""}">
        <header>
          <h2>${escapeHtml(formatDayHeading(iso))}</h2>
          ${iso === today ? `<span class="badge">Today</span>` : ""}
        </header>
        ${body}
      </section>`;
  }).join("");

  return `${strip}<div class="my-days">${blocks}</div>`;
}

function storedDensity() {
  try {
    return localStorage.getItem("roster-density") === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
}

function defaultSpan(mondayIso) {
  const index = weekDates(mondayIso).indexOf(sydneyToday());
  return index >= 5 ? "weekend" : "weekday";
}

function plannerGrid() {
  return isRosterEditor() && (state.view === "plan" || state.view === "day");
}

function defaultDay(weekStart) {
  const days = weekDates(weekStart || state.weekStart);
  const today = sydneyToday();
  return days.includes(today) ? today : days[0];
}

function selectedDay() {
  const days = weekDates(state.weekStart);
  if (state.focusDay && days.includes(state.focusDay)) return state.focusDay;
  return defaultDay(state.weekStart);
}

function visiblePlanDays() {
  if (state.view === "day") return [selectedDay()];
  const days = weekDates(state.weekStart);
  return state.planSpan === "weekend" ? days.slice(5) : days.slice(0, 5);
}

function dayNavHtml() {
  const days = weekDates(state.weekStart);
  const selected = selectedDay();
  const today = sydneyToday();
  const index = days.indexOf(selected);
  const chips = days.map((iso) => {
    const short = formatDayShort(iso);
    const active = iso === selected ? " is-active" : "";
    const mark = iso === today ? " is-today" : "";
    return `<button type="button" class="day-chip${active}${mark}" data-pick-day="${iso}" aria-pressed="${iso === selected ? "true" : "false"}">${short.dow}<span>${short.date.split(" ")[0]}</span></button>`;
  }).join("");
  const label = `${selected === today ? "Today · " : ""}${formatDayHeading(selected)}`;
  return `<div class="day-nav">
    <button type="button" class="icon-btn day-step" data-day-step="-1" ${index <= 0 ? "disabled" : ""} aria-label="Previous day">‹</button>
    <div class="day-chips" role="group" aria-label="Day in this week">${chips}</div>
    <button type="button" class="icon-btn day-step" data-day-step="1" ${index >= days.length - 1 ? "disabled" : ""} aria-label="Next day">›</button>
    <span class="day-nav-label">${escapeHtml(label)}</span>
  </div>`;
}

function closedSections() {
  try {
    const parsed = JSON.parse(localStorage.getItem("roster-sections-closed") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sectionOpen(id) {
  return closedSections()[id] !== true;
}

function toggleSection(id) {
  const closed = closedSections();
  if (closed[id]) delete closed[id];
  else closed[id] = true;
  try { localStorage.setItem("roster-sections-closed", JSON.stringify(closed)); } catch { /* private mode */ }
  renderView();
}

function dispatcherDate() {
  if (state.view === "day") return selectedDay();
  const days = visiblePlanDays();
  const today = sydneyToday();
  if (days.includes(today)) return today;
  return days[0] || state.weekStart;
}

function dispatcherHtml() {
  const date = dispatcherDate();
  const row = state.dispatchers[date] || {};
  const name = (row.name || "").trim();
  const note = (row.note || "").trim();
  const day = formatDayHeading(date);
  if (!isStatusEditor()) {
    const who = name ? escapeHtml(name) : "Not set";
    const extra = note ? ` – ${escapeHtml(note)}` : "";
    return `<div class="dispatcher"><span>Current Dispatcher:</span> <strong>${who}</strong>${extra}<span class="dispatcher-day">${escapeHtml(day)}</span></div>`;
  }
  return `<form class="dispatcher" data-dispatcher="${escapeHtml(date)}">
    <span>Current Dispatcher:</span>
    <input name="dispatcher-name" maxlength="80" aria-label="Dispatcher name" placeholder="Name" value="${escapeHtml(name)}">
    <span aria-hidden="true">–</span>
    <input name="dispatcher-note" maxlength="80" aria-label="Dispatcher note" placeholder="Note" value="${escapeHtml(note)}">
    <span class="dispatcher-day">${escapeHtml(day)}</span>
    <button type="submit">Save</button>
  </form>`;
}

function planSections(rows) {
  const core = SECTIONS.filter((section) => section.id !== "Other");
  const extra = [...new Set(rows.map((row) => row.section).filter((id) => id && !SECTION_IDS.has(id)))];
  const other = rows.some((row) => row.section === "Other") ? [{ id: "Other", title: "Other" }] : [];
  return [...core, ...other, ...extra.map((id) => ({ id, title: id }))];
}

function modeVehicle(byDay) {
  const counts = new Map();
  for (const items of byDay.values()) {
    for (const row of items) {
      if (!row.vehicle_id) continue;
      counts.set(row.vehicle_id, (counts.get(row.vehicle_id) || 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function peakPeriod(shift) {
  const minutes = shiftStartMinutes(shift);
  if (minutes == null) return "";
  return minutes < 12 * 60 ? "am" : "pm";
}

function shiftBand(shift) {
  const minutes = shiftStartMinutes(shift);
  if (minutes == null) return "";
  const bands = [
    ["0630", 6 * 60 + 30],
    ["0730", 7 * 60 + 30],
    ["1030", 10 * 60 + 30],
    ["1430", 14 * 60 + 30],
  ];
  let best = bands[0][0];
  let bestDist = Infinity;
  for (const [id, at] of bands) {
    const dist = Math.abs(minutes - at);
    if (dist < bestDist) {
      best = id;
      bestDist = dist;
    }
  }
  return best;
}

function sortPlanGroups(list) {
  list.sort((a, b) => comparePlanLines(
    { shift: a.sample.shift, name: personName(a.sample), ot: isOt(a.sample), id: a.sample.id },
    { shift: b.sample.shift, name: personName(b.sample), ot: isOt(b.sample), id: b.sample.id },
  ));
}

function sameShift(a, b) {
  const norm = (value) => String(value || "").replace(/\s+/g, "").replace(/[–—]/g, "-");
  return norm(a) === norm(b);
}

function planCell(items, rowShift) {
  return items.map((row) => {
    const ot = isOt(row);
    const status = row.status || "draft";
    const title = [officerLabel(row), ot ? "Overtime" : "", formatShift(row.shift), row.vehicle_id, row.function, row.peak, areaLabel(row.area), row.notes, STATUS_LABEL[status]].filter(Boolean).join(" · ");
    const open = `data-open="${escapeHtml(row.id)}" title="${escapeHtml(title)}"`;
    if (status === "sick") {
      return `<button type="button" class="cell-hit status-sick" ${open}><span class="cell-main">Sick</span></button>`;
    }
    if (status === "leave") {
      return `<button type="button" class="cell-hit status-leave" ${open}><span class="cell-main">Leave</span>${row.notes ? `<span class="cell-sub">${escapeHtml(row.notes)}</span>` : ""}</button>`;
    }
    if (status === "stood_down") {
      return `<button type="button" class="cell-hit status-stood_down" ${open}><span class="cell-main">${escapeHtml(STATUS_LABEL.stood_down)}</span></button>`;
    }
    const placed = peakAndArea(row.peak, row.area);
    const peak = placed.peak;
    const area = areaLabel(placed.area);
    const period = peakPeriod(row.shift || rowShift);
    const override = row.shift && rowShift && !sameShift(row.shift, rowShift)
      ? `<span class="cell-sub">${escapeHtml(formatShift(row.shift))}</span>`
      : "";
    const split = peak && (status === "published" || status === "ot" || ot);
    if (split) {
      const place = area ? `<span class="cell-area">${escapeHtml(area)}</span>` : "";
      return `<button type="button" class="cell-hit status-${escapeHtml(status)}${ot ? " is-ot-cell" : ""}" ${open}><span class="cell-split"><span class="peak-strip peak-${period || "na"}">${escapeHtml(peak)}</span><span class="cell-detail">${place}${override}</span></span></button>`;
    }
    const place = area ? `<span class="cell-area">${escapeHtml(area)}</span>` : "";
    const peakText = peak ? `<span class="cell-main">${escapeHtml(peak)}</span>` : "";
    const fallback = !peakText && !place ? `<span class="cell-main">${escapeHtml(row.function || "On")}</span>` : "";
    return `<button type="button" class="cell-hit status-${escapeHtml(status)}${ot ? " is-ot-cell" : ""}" ${open}>${peakText}${place}${fallback}${override}</button>`;
  }).join("");
}

function renderPlan(rows) {
  const today = sydneyToday();
  const days = visiblePlanDays();
  const daySet = new Set(days);
  const filtered = rows.filter((row) => daySet.has(row.work_date) && passesFilter(row));
  const searching = state.planQuery.trim() !== "";
  const outside = rows.filter((row) => !daySet.has(row.work_date) && passesFilter(row) && matchesRosterQuery(state.planQuery, searchFieldsForRow(row))).length;
  const groups = groupPlanLines(filtered);
  if (searching) {
    for (const [key, group] of [...groups]) {
      if (!groupMatchesSearch(group)) groups.delete(key);
    }
  }

  const head = days.map((iso) => {
    const short = formatDayShort(iso);
    return `<th class="${iso === today ? "is-today" : ""}" scope="col">${short.dow}<span>${short.date}</span></th>`;
  }).join("");

  const sections = planSections(rows).filter((section) => {
    const has = [...groups.values()].some((group) => group.section === section.id);
    if (searching) return has;
    if (isRosterEditor()) return true;
    return has;
  });
  const body = sections.map((section) => {
    const list = [...groups.values()].filter((group) => group.section === section.id);
    sortPlanGroups(list);
    const open = sectionOpen(section.id);
    const band = `<tr class="section-band${open ? "" : " is-collapsed"}" data-section="${escapeHtml(section.id)}">
      <th colspan="${4 + days.length}" scope="colgroup">
        <button type="button" class="band-toggle" data-toggle-section="${escapeHtml(section.id)}" aria-expanded="${open ? "true" : "false"}">
          <span class="band-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
          <span class="band-title">${escapeHtml(section.title)}</span>
        </button>
        <span class="band-key">${escapeHtml(section.id)}</span>
        <span class="band-count">${list.length}</span>
        ${isRosterEditor() && !weekLocked() ? `<button type="button" class="band-add" data-add data-date="${days[0]}" data-section="${escapeHtml(section.id)}">Add</button>` : ""}
      </th>
    </tr>`;
    if (!list.length) return searching ? "" : band;
    if (!open) return band;
    const lines = list.map((group) => {
      const vehicle = modeVehicle(group.byDay);
      const otRow = isOt(group.sample);
      const code = group.sample.officer_code;
      const lineKey = group.lineKey;
      const radio = presenceOf(code, lineKey);
      const role = signOnRole(code);
      const exempt = exemptFromSignOn({ code, section: section.id, role });
      const todayItems = group.byDay.get(today) || [];
      const late = isStatusEditor() && days.includes(today) && !exempt && !lateMarkerCleared(radio) && signOnState({
        items: todayItems,
        rowShift: group.sample.shift,
        online: false,
        nowMinutes: sydneyClockMinutes(),
        code,
        role,
      }).late;
      const cells = days.map((iso) => {
        const items = group.byDay.get(iso) || [];
        const todayClass = iso === today ? " is-today" : "";
        const keepColour = items.some((row) => row.status === "sick" || row.status === "stood_down");
        const paint = dayCellPaint({
          exempt,
          iso,
          today,
          status: radio.status,
          keepColour,
        });
        const ended = paint.ended ? " is-ended" : "";
        const lateDay = late && iso === today && !keepColour ? " is-late-day" : "";
        if (!items.length) {
          const add = isRosterEditor() && !weekLocked()
            ? `<button type="button" class="cell-add" data-add data-date="${iso}" data-section="${escapeHtml(section.id)}" data-code="${escapeHtml(code || "")}" data-shift="${escapeHtml(otRow ? "" : (group.sample.shift || ""))}" data-vehicle="${escapeHtml(vehicle)}" data-function="${escapeHtml(group.sample.function || "")}" ${otRow ? "data-ot=\"1\"" : ""} aria-label="Add ${escapeHtml(section.title)} on ${escapeHtml(formatDayHeading(iso))}"></button>`
            : "";
          return `<td class="day-cell is-empty${otRow ? " is-ot-cell" : ""}${todayClass}${ended}${lateDay}">${add}</td>`;
        }
        const status = items[0].status || "draft";
        const otCell = items.some(isOt);
        const tone = !otCell && status === "published"
          ? items.reduce((found, row) => found || areaTone(peakAndArea(row.peak, row.area).area), "")
          : "";
        const toneClass = tone === "processing" ? " is-processing" : tone === "met" ? " is-met" : "";
        const cellFade = paint.unsigned ? " is-unsigned" : "";
        return `<td class="day-cell status-${escapeHtml(status)}${otCell ? " is-ot-cell" : ""}${todayClass}${cellFade}${ended}${lateDay}${toneClass}">${planCell(items, group.sample.shift)}</td>`;
      }).join("");
      const otButton = isRosterEditor() && !weekLocked() && !otRow && group.sample.officer_code
        ? `<button type="button" class="row-ot" data-add-ot data-date="${days.includes(today) ? today : days[0]}" data-section="${escapeHtml(section.id)}" data-code="${escapeHtml(group.sample.officer_code)}" data-function="${escapeHtml(group.sample.function || "")}" data-vehicle="${escapeHtml(vehicle)}" title="Add an overtime line" aria-label="Add overtime line for ${escapeHtml(personName(group.sample))}">OT</button>`
        : "";
      const showCode = code && personName(group.sample) !== code;
      const channel = officerByCode(code)?.radio || "";
      const band = shiftBand(group.sample.shift);
      return `<tr class="${otRow ? "is-ot" : ""}${late ? " is-late" : ""}" data-section="${escapeHtml(section.id)}">
        <th class="who-cell" scope="row" title="${escapeHtml([officerLabel(group.sample), otRow ? "Overtime" : "", PRESENCE[radio.status].label, late ? "Late sign-on" : "", radio.note].filter(Boolean).join(" · "))}">
          <span class="who-line-name">${presenceChip(code, lineKey, late)}<button type="button" class="who-name" data-contact="${escapeHtml(code || "")}">${escapeHtml(personName(group.sample))}</button>${showCode ? `<span class="who-code">${escapeHtml(code)}</span>` : ""}</span>
          ${otButton}
        </th>
        <td class="radio-cell" title="${escapeHtml(channel)}"><span class="clip">${escapeHtml(channel || "—")}</span></td>
        <td class="shift-cell${band ? ` shift-band-${band}` : ""}"><span class="clip">${escapeHtml(group.sample.shift ? formatShift(group.sample.shift) : "—")}</span></td>
        <td class="veh-cell" title="${escapeHtml(vehicle || "")}">${vehicle ? `<span class="veh-pill">${escapeHtml(vehicle)}</span>` : `<span class="clip">—</span>`}</td>
        ${cells}
      </tr>`;
    }).join("");
    return band + lines;
  }).join("");

  const otherSpan = state.planSpan === "weekend" ? "weekday" : "weekend";
  const otherLabel = state.planSpan === "weekend" ? "Mon–Fri" : "Sat–Sun";
  const outsideNote = state.view === "day" || !outside
    ? ""
    : `<button type="button" class="text-btn span-jump" data-span="${otherSpan}">${outside} line${outside === 1 ? "" : "s"} on ${otherLabel}</button>`;
  const visibleCount = [...groups.values()].reduce((sum, group) => {
    for (const items of group.byDay.values()) sum += items.length;
    return sum;
  }, 0);
  const filterNote = searching && !visibleCount
    ? `<p class="keyline">No lines match “${escapeHtml(state.planQuery.trim())}”.</p>`
    : state.view === "day" && !filtered.length
    ? `<p class="keyline">No lines on ${escapeHtml(formatDayHeading(selectedDay()))}.</p>`
    : rows.length && !filtered.length && !outside
      ? `<p class="keyline">No ${escapeHtml(state.statusFilter === "stood_down" ? STATUS_LABEL.stood_down : (STATUS_LABEL[state.statusFilter] || "matching").toLowerCase())} lines in this half of the week.</p>`
      : "";
  const editNote = isRosterEditor() && !weekLocked() ? "click a cell to edit" : "read only";
  const nav = state.view === "day" ? dayNavHtml() : "";

  return `
    ${dispatcherHtml()}
    ${nav}
    <div class="keyline">
      <span class="key pub">Published</span>
      <span class="key draft">Draft</span>
      <span class="key leave">Leave</span>
      <span class="key ot">Overtime</span>
      <span class="key down">${STATUS_LABEL.stood_down}</span>
      <span class="key end">${PRESENCE.end.label}</span>
      <span class="key sick">Sick</span>
      ${isStatusEditor() ? `<span class="key late">LATE</span>` : ""}
      <span class="key peak-am">Peak AM</span>
      <span class="key peak-pm">Peak PM</span>
      <span class="keyline-count">${visibleCount} lines · ${weekLocked() && isRosterEditor() ? "archived, read only" : editNote}</span>
      ${outsideNote}
    </div>
    ${filterNote}
    <div class="plan-scroll">
      <table class="plan-table${state.view === "day" ? " is-day" : ""}" data-density="${escapeHtml(state.density)}" style="--day-count: ${days.length}">
        <colgroup>
          <col class="col-who">
          <col class="col-radio">
          <col class="col-shift">
          <col class="col-veh">
          ${days.map(() => `<col class="col-day">`).join("")}
        </colgroup>
        <thead>
          <tr>
            <th class="who-cell" scope="col">Officer</th>
            <th class="radio-cell" scope="col">Radio</th>
            <th class="shift-cell" scope="col">Shift</th>
            <th class="veh-cell" scope="col">Vehicle</th>
            ${head}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function officerHay(officer) {
  return [officer.name, officer.code, officer.radio, officer.contact, officer.team, officer.function]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function officerVisible(officer) {
  const mode = state.officerFilter;
  const active = officer.active !== false;
  if (mode === "active" && !active) return false;
  if (mode === "inactive" && active) return false;
  const query = state.officerQuery.trim().toLowerCase();
  if (!query) return true;
  return officerHay(officer).includes(query);
}

function renderOfficerForm() {
  const draft = state.officerDraft;
  if (!draft) return "";
  const row = draft.id ? state.officers.find((officer) => officer.id === draft.id) : null;
  const value = (field, fallback = "") => escapeHtml(row?.[field] ?? fallback);
  const active = row ? row.active !== false : true;
  return `<form class="officer-form" data-officer-form>
    <h3>${row ? "Edit officer" : "Add officer"}</h3>
    <div class="officer-fields">
      <label>Name<input name="name" required maxlength="80" value="${value("name")}" autocomplete="off"></label>
      <label>Code<input name="code" maxlength="16" value="${value("code")}" placeholder="Optional" autocomplete="off"></label>
      <label>Radio<input name="radio" maxlength="20" value="${value("radio")}" autocomplete="off"></label>
      <label>Contact<input name="contact" maxlength="40" value="${value("contact")}" autocomplete="off"></label>
      <label>Team<input name="team" maxlength="40" list="list-team" value="${value("team")}" autocomplete="off"></label>
      <label>Function<input name="function" maxlength="40" list="list-function" value="${value("function")}" autocomplete="off"></label>
      <label class="officer-active"><input name="active" type="checkbox"${active ? " checked" : ""}> Active</label>
    </div>
    <p class="hint">Code is optional. When it is set, shifts match on it. Deactivate someone to drop them from the add-line list. Past lines stay.</p>
    <div class="officer-actions">
      <button type="submit" class="primary">${row ? "Save officer" : "Add officer"}</button>
      <button type="button" class="ghost" data-officer-cancel>Cancel</button>
      ${row && active ? `<button type="button" class="danger" data-officer-deactivate>Deactivate</button>` : ""}
    </div>
  </form>`;
}

function renderOfficers() {
  const rows = [...state.officers].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const visible = rows.filter(officerVisible);
  const body = visible.map((officer) => {
    const active = officer.active !== false;
    return `<tr data-officer-row>
      <td>${escapeHtml(officer.name || "")}</td>
      <td>${escapeHtml(officer.code || "—")}</td>
      <td>${escapeHtml(officer.radio || "—")}</td>
      <td>${escapeHtml(officer.contact || "—")}</td>
      <td>${escapeHtml(officer.team || "—")}</td>
      <td>${escapeHtml(officer.function || "—")}</td>
      <td>${active ? "Active" : "Inactive"}</td>
      <td><button type="button" class="ghost" data-officer-edit="${escapeHtml(officer.id)}">Edit</button></td>
    </tr>`;
  }).join("");
  const empty = visible.length
    ? ""
    : `<p class="keyline">${rows.length ? "No officers match that search." : "No officers in the directory yet."}</p>`;
  const chips = ["active", "inactive", "all"].map((id) => {
    const label = id === "active" ? "Active" : id === "inactive" ? "Inactive" : "All";
    return `<button type="button" class="chip${state.officerFilter === id ? " is-active" : ""}" data-officer-filter="${id}">${label}</button>`;
  }).join("");
  return `<section class="directory">
    <div class="directory-bar">
      <div>
        <h2>Officers</h2>
        <p>Add a person, update radio and phone, or mark them inactive. Admin and SLG only.</p>
      </div>
      <button type="button" class="primary" data-officer-add>Add officer</button>
    </div>
    <div class="directory-tools">
      <input data-officer-query type="search" placeholder="Search name, code, radio, or phone" value="${escapeHtml(state.officerQuery)}" autocomplete="off">
      <div class="filters">${chips}</div>
    </div>
    ${renderOfficerForm()}
    ${empty}
    <div class="plan-scroll">
      <table class="directory-table">
        <thead>
          <tr>
            <th>Name</th><th>Code</th><th>Radio</th><th>Contact</th><th>Team</th><th>Function</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

async function saveOfficer(form, { active } = {}) {
  if (!isOfficerAdmin()) return;
  const name = form.elements.name.value.trim();
  const code = form.elements.code.value.trim() || null;
  if (!name) {
    toast("Name is required.");
    return;
  }
  const payload = {
    name,
    code,
    radio: form.elements.radio.value.trim() || null,
    contact: form.elements.contact.value.trim() || null,
    team: form.elements.team.value.trim() || null,
    function: form.elements.function.value.trim() || null,
    active: active === undefined ? form.elements.active.checked : active,
  };
  const id = state.officerDraft?.id;
  const query = id
    ? supabase.from("roster_officers").update(payload).eq("id", id).select("id,name,code,radio,contact,function,team,active").single()
    : supabase.from("roster_officers").insert(payload).select("id,name,code,radio,contact,function,team,active").single();
  const { data, error } = await query;
  if (error) {
    toast(/duplicate|23505/i.test(error.message || "") ? "That code is already used." : friendlyError(error));
    return;
  }
  const index = state.officers.findIndex((officer) => officer.id === data.id);
  if (index >= 0) state.officers[index] = data;
  else state.officers.push(data);
  state.officerDraft = null;
  toast(payload.active === false ? "Officer deactivated." : id ? "Officer updated." : "Officer added.");
  renderView();
}

function renderView() {
  const scroller = document.querySelector(".plan-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const scrollLeft = scroller ? scroller.scrollLeft : 0;
  renderChrome();
  $("app-banner").innerHTML = bannerHtml();
  const view = $("view");
  if (state.view === "officers") {
    view.innerHTML = renderOfficers();
    view.setAttribute("aria-busy", "false");
    const query = view.querySelector("[data-officer-query]");
    if (query && state.officerQuery) {
      query.focus();
      const end = query.value.length;
      query.setSelectionRange(end, end);
    }
    return;
  }
  if (state.loading && !state.assignments.length) {
    view.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span> Loading this week…</div>`;
    view.setAttribute("aria-busy", "true");
    return;
  }
  view.setAttribute("aria-busy", state.loading ? "true" : "false");
  const rows = rowsForView();
  const grid = state.view === "plan" || state.view === "day";
  view.innerHTML = grid ? renderPlan(rows) : renderMine(rows);
  const nextScroller = document.querySelector(".plan-scroll");
  if (nextScroller) {
    nextScroller.scrollTop = scrollTop;
    nextScroller.scrollLeft = scrollLeft;
  }
}

function fillList(id, values) {
  $(id).innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function refreshLists() {
  fillList("list-shift", state.lists.shift);
  fillList("list-function", state.lists.function);
  fillList("list-peak", [...new Set([...(state.lists.peak || []), ...(state.lists.task || [])])]);
  fillList("list-area", state.lists.area);
  const vehicles = state.fleet
    .filter((vehicle) => vehicle.status !== "decommissioned")
    .map((vehicle) => vehicle.vehicle_id);
  fillList("list-vehicle", vehicles);
  const officerList = $("list-officer");
  if (officerList) {
    officerList.innerHTML = state.officers
      .filter((officer) => officer.active !== false && officer.code)
      .map((officer) => `<option value="${escapeHtml(officer.code)}">${escapeHtml(officer.name)}</option>`)
      .join("");
  }

  const select = $("f-officer");
  const current = select.value;
  const options = [`<option value="">Not linked to the directory</option>`];
  const sorted = [...state.officers].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  for (const officer of sorted) {
    const inactive = officer.active ? "" : " (inactive)";
    const code = officer.code ? ` · ${officer.code}` : "";
    options.push(`<option value="${escapeHtml(officer.id)}">${escapeHtml(officer.name)}${escapeHtml(code)}${inactive}</option>`);
  }
  select.innerHTML = options.join("");
  if (current) select.value = current;
  $("officer-label").hidden = state.officers.length === 0;
}

function applyLookups(rows) {
  const next = { shift: [], function: [], task: [], area: [] };
  const groupedRows = { shift: [], function: [], task: [], area: [] };
  for (const row of rows || []) {
    const type = String(row.lookup_type || "").trim().toLowerCase();
    for (const key of Object.keys(LOOKUP_ALIASES)) {
      if (LOOKUP_ALIASES[key].includes(type) && row.value) groupedRows[key].push(row);
    }
  }
  let fallback = false;
  for (const key of Object.keys(next)) {
    const list = groupedRows[key].sort((a, b) => (a.sort_index ?? 0) - (b.sort_index ?? 0) || String(a.value).localeCompare(String(b.value)));
    const values = [...new Set(list.map((row) => String(row.value).trim()).filter(Boolean))];
    if (values.length) next[key] = values;
    else {
      next[key] = FALLBACK[key];
      fallback = true;
    }
  }
  state.lists = next;
  state.usingFallback = fallback;
  refreshLists();
}

async function loadDirectories() {
  const [officers, fleet, lookups] = await Promise.all([
    supabase.from("roster_officers").select("id,name,code,radio,contact,function,team,active").order("name"),
    supabase.from("roster_fleet").select("vehicle_id,vehicle_type,status").order("vehicle_id"),
    supabase.from("roster_lookups").select("lookup_type,value,sort_index").order("sort_index"),
  ]);
  state.officers = officers.error ? [] : officers.data || [];
  state.fleet = fleet.error ? [] : fleet.data || [];
  applyLookups(lookups.error ? [] : lookups.data || []);
  const problems = [];
  if (officers.error) problems.push("Officer directory didn’t load.");
  if (isRosterEditor() && fleet.error) problems.push("Fleet list didn’t load.");
  if (problems.length) toast(problems.join(" "));
}

async function loadAssignments({ silent = false } = {}) {
  if (cellEditor.open) {
    reloadQueued = true;
    return;
  }
  reloadQueued = false;
  const seq = ++loadSeq;
  if (!silent) {
    state.loading = true;
    state.error = "";
    renderView();
  }
  const start = state.weekStart;
  const end = addDays(start, 6);
  const [{ data, error }, meta, dispatch] = await Promise.all([
    supabase
      .from("roster_assignments")
      .select("id,work_date,section,officer_id,officer_code,shift,function,vehicle_id,peak,task,area,notes,status,is_ot,archived_at")
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date", { ascending: true })
      .limit(2000),
    supabase
      .from("roster_week_meta")
      .select("week_start,archived_at,restored_at")
      .eq("week_start", start)
      .maybeSingle(),
    supabase
      .from("roster_dispatcher")
      .select("work_date,name,note")
      .gte("work_date", start)
      .lte("work_date", end),
  ]);
  if (!dispatch.error) {
    const next = {};
    for (const row of dispatch.data || []) next[row.work_date] = row;
    state.dispatchers = next;
  }
  if (!meta.error) state.weekMeta = meta.data || null;
  if (seq !== loadSeq) return;
  state.loading = false;
  if (error) {
    if (!silent) state.assignments = [];
    state.error = friendlyError(error);
  } else {
    state.assignments = data || [];
    state.error = "";
    const live = new Set(state.assignments.map((row) => row.id));
    for (const id of state.unread) {
      if (!live.has(id)) state.unread.delete(id);
    }
  }
  renderView();
}

function scheduleReload() {
  if (cellEditor.open) {
    reloadQueued = true;
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadAssignments({ silent: true }), 200);
}

function flushReload() {
  if (!reloadQueued || cellEditor.open) return;
  reloadQueued = false;
  loadAssignments({ silent: true });
}

function stepWeek(delta) {
  const target = addDays(state.weekStart, delta * 7);
  const onGrid = state.view === "plan" || state.view === "day";
  if (!onGrid || !isRosterEditor()) {
    if (onGrid && target > addDays(thisMonday(), 7)) return;
    setWeek(target);
    return;
  }
  if (state.board !== "archive") {
    if (target < thisMonday()) {
      state.board = "archive";
      setWeek(addDays(thisMonday(), -7));
      return;
    }
    if (target > addDays(thisMonday(), 7)) return;
  } else if (target >= thisMonday()) {
    state.board = "live";
    setWeek(thisMonday());
    return;
  }
  setWeek(target);
}

function setBoard(board) {
  state.board = board === "archive" ? "archive" : "live";
  if (state.board === "archive" && state.weekStart >= thisMonday()) setWeek(addDays(thisMonday(), -7));
  else if (state.board === "live" && !isLiveWeek(state.weekStart)) setWeek(thisMonday());
  else renderView();
}

async function autoArchivePastWeeks() {
  if (!isRosterEditor()) return;
  const { error } = await supabase.rpc("archive_past_roster_weeks");
  if (error && !state.archiveWarned) {
    state.archiveWarned = true;
    toast("Couldn’t archive past weeks. This week is still editable.");
  }
}

async function setWeekArchived(archive) {
  const { error } = await supabase.rpc("set_roster_week_archived", {
    p_week: state.weekStart,
    p_archive: archive,
  });
  if (error) {
    toast(friendlyError(error));
    return;
  }
  toast(archive ? "Week archived" : "Week restored");
  if (archive && state.board !== "archive" && state.weekStart < thisMonday()) state.board = "archive";
  await loadAssignments();
}

function setWeek(iso, { replace = false, keepOffset = true } = {}) {
  const monday = mondayOf(iso);
  const changed = monday !== state.weekStart;
  state.weekStart = monday;
  if (!keepOffset) {
    const today = sydneyToday();
    const dates = weekDates(monday);
    const index = dates.indexOf(today);
    state.focusOffset = index >= 0 ? index : 0;
  }
  if (changed || !weekDates(monday).includes(state.focusDay)) state.focusDay = defaultDay(monday);
  writeRoute(replace);
  renderChrome();
  if (changed) loadAssignments();
  else renderView();
}

function setFocusDay(iso) {
  const days = weekDates(state.weekStart);
  if (!days.includes(iso) || iso === selectedDay()) return;
  state.focusDay = iso;
  writeRoute(false);
  renderView();
}

function setView(view, { replace = false } = {}) {
  state.deniedPlan = false;
  if (view === "officers" && !isOfficerAdmin()) {
    state.deniedPlan = true;
    state.view = "my-week";
  } else if (view === "day") {
    state.view = "day";
    if (!weekDates(state.weekStart).includes(state.focusDay)) state.focusDay = defaultDay(state.weekStart);
  } else if (view === "plan") {
    state.view = "plan";
  } else if (view === "officers") {
    state.view = "officers";
  } else {
    state.view = "my-week";
  }
  writeRoute(replace);
  renderView();
}

async function enterApp(user) {
  if (enteredFor === user.id && !$("screen-app").hidden) return;
  enteredFor = user.id;
  state.user = user;
  show("boot", false);
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,role,display_name,officer_code")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    showLogin();
    $("login-error").hidden = false;
    $("login-error").textContent = friendlyError(error);
    return;
  }
  if (!data) {
    showLogin();
    $("login-error").hidden = false;
    $("login-error").textContent = "This account has no profile row yet. An admin needs to add one before the roster can open.";
    return;
  }
  state.profile = data;
  state.unread = new Set();
  const route = readRoute();
  const today = sydneyToday();
  const requested = route.week || mondayOf(today);
  state.weekStart = requested > addDays(mondayOf(today), 7) ? addDays(mondayOf(today), 7) : requested;
  state.board = state.weekStart < mondayOf(today) ? "archive" : "live";
  state.planSpan = defaultSpan(state.weekStart);
  state.density = storedDensity();
  const dates = weekDates(state.weekStart);
  const todayIndex = dates.indexOf(today);
  state.focusOffset = todayIndex >= 0 ? todayIndex : 0;
  state.focusDay = route.day && dates.includes(route.day) ? route.day : defaultDay(state.weekStart);
  state.view = "my-week";
  state.deniedPlan = false;
  show("screen-login", false);
  show("screen-app", true);
  if (route.view === "plan") setView("plan", { replace: true });
  else if (route.view === "day") setView("day", { replace: true });
  else if (route.view === "officers") setView("officers", { replace: true });
  else writeRoute(true);
  renderChrome();
  await loadDirectories();
  subscribeRoster();
  await autoArchivePastWeeks();
  await loadAssignments();
  await loadPresence();
  await loadSignOnExemptCodes();
  watchSignOn();
}

function showLogin() {
  enteredFor = null;
  state.user = null;
  state.profile = null;
  state.assignments = [];
  state.unread = new Set();
  state.presence = {};
  state.signOnExemptCodes = new Set();
  unsubscribeRoster();
  closePresenceMenu();
  document.body.classList.remove("is-plan");
  show("boot", false);
  show("screen-app", false);
  show("screen-login", true);
  closeCellEditor({ flush: false });
  closeModal();
}

function blankForm() {
  $("assignment-form").reset();
  $("f-status").value = "draft";
  $("form-error").hidden = true;
  $("delete-confirm").hidden = true;
  $("delete-assignment").hidden = true;
  $("officer-meta").textContent = "";
  $("form-hint").textContent = state.usingFallback
    ? "Shift, function, task, and area lists include the deployment-plan defaults until roster_lookups is filled. My week matches the officer code on the person’s profile."
    : "My week matches the officer code on the person’s profile.";
}

function openModal(row, preset = {}) {
  if (isRosterEditor() && !weekLocked()) {
    openCellEditor(row, preset, document.activeElement);
    return;
  }
  state.lastFocus = document.activeElement;
  state.editingId = null;
  $("assignment-form").hidden = true;
  $("read-panel").hidden = false;
  $("modal-title").textContent = "Shift detail";
  $("modal-kicker").textContent = weekLocked() ? "Archived week" : (row?.section || "Assignment");
  $("readout").innerHTML = readoutHtml(row);
  show("modal", true);
  $("read-close").focus();
}

function readoutHtml(row) {
  if (!row) return "";
  const pairs = [
    ["Date", formatDayHeading(row.work_date)],
    ["Section", row.section],
    ["Officer", officerLabel(row)],
    ["Shift", formatShift(row.shift)],
    ["Function", row.function || "—"],
    ["Vehicle", row.vehicle_id || "—"],
    ["Peak", row.peak || "—"],
    ["Area", row.area || "—"],
    ["Status", STATUS_LABEL[row.status] || row.status || "—"],
    ["Notes", row.notes || "—"],
  ];
  return pairs.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function closeModal() {
  show("modal", false);
  state.editingId = null;
  if (state.lastFocus && typeof state.lastFocus.focus === "function") state.lastFocus.focus();
}

function updateOfficerMeta() {
  const officer = officerById($("f-officer").value) || officerByCode($("f-code").value.trim());
  if (!officer) {
    $("officer-meta").textContent = state.officers.length
      ? ""
      : "Officer directory is empty. Type the code that matches profiles.officer_code.";
    return;
  }
  const bits = [officer.team, officer.function, officer.radio && `Radio ${officer.radio}`, officer.contact].filter(Boolean);
  $("officer-meta").textContent = bits.join(" · ");
}

function payloadFromForm() {
  const selected = officerById($("f-officer").value);
  const typed = $("f-code").value.trim();
  const matched = officerByCode(typed);
  const officer = selected || matched;
  const code = selected ? selected.code : typed;
  return {
    work_date: $("f-date").value,
    section: $("f-section").value,
    officer_id: officer?.id || null,
    officer_code: code || null,
    shift: $("f-shift").value.trim() || null,
    function: $("f-function").value.trim() || null,
    vehicle_id: $("f-vehicle").value.trim() || null,
    peak: $("f-peak").value.trim() || null,
    area: $("f-area").value.trim() || null,
    notes: $("f-notes").value.trim() || null,
    status: $("f-status").value,
    updated_at: new Date().toISOString(),
  };
}

async function saveAssignment(event) {
  event.preventDefault();
  if (!isRosterEditor() || weekLocked()) return;
  const payload = payloadFromForm();
  payload.is_ot = payload.status === "ot";
  if (!isValidISODate(payload.work_date)) {
    $("form-error").hidden = false;
    $("form-error").textContent = "Choose a valid date.";
    return;
  }
  if (!SECTION_IDS.has(payload.section)) {
    $("form-error").hidden = false;
    $("form-error").textContent = "Choose a section from the list.";
    return;
  }
  const editingId = state.editingId;
  const button = $("save-assignment");
  button.disabled = true;
  button.textContent = "Saving…";
  $("form-error").hidden = true;
  const saved = await saveTickedDays(payload, { editingId, root: $("form-copy-days") });
  button.disabled = false;
  button.textContent = "Save assignment";
  if (saved.error) {
    $("form-error").hidden = false;
    $("form-error").textContent = saved.error.message && !saved.error.code ? saved.error.message : friendlyError(saved.error);
    return;
  }
  const savedDate = saved.days?.includes(payload.work_date) ? payload.work_date : (saved.days?.[0] || payload.work_date);
  closeModal();
  toast(saved.count > 1 ? `Assignment saved on ${saved.count} days` : (editingId ? "Assignment updated" : "Assignment added"));
  if (mondayOf(savedDate) !== state.weekStart) setWeek(savedDate, { keepOffset: false });
  else loadAssignments();
}

async function removeAssignment() {
  const id = state.editingId;
  if (!id || !isRosterEditor() || weekLocked()) return;
  const button = $("delete-confirm-btn");
  button.disabled = true;
  const { data, error } = await supabase.from("roster_assignments").delete().eq("id", id).select("id");
  button.disabled = false;
  if (error || !data?.length) {
    $("form-error").hidden = false;
    $("form-error").textContent = error ? friendlyError(error) : "That line is already gone, or you can’t remove it.";
    $("delete-confirm").hidden = true;
    return;
  }
  closeModal();
  toast("Assignment removed");
  loadAssignments();
}

function shiftChangeCopy(kind, row) {
  const day = row?.work_date ? formatDayShort(row.work_date).dow : "";
  const verb = kind === "added" ? "added" : kind === "removed" ? "removed" : "updated";
  const title = day ? `Your ${day} shift was ${verb}` : `Your shift was ${verb}`;
  const bits = [];
  if (row?.shift) bits.push(formatShift(row.shift));
  if (row?.status === "leave") bits.push("Leave");
  else if (row?.status === "stood_down") bits.push(STATUS_LABEL.stood_down);
  else if (row?.status === "sick") bits.push("Sick");
  else {
    if (row?.peak) bits.push(row.peak);
    if (row?.area) bits.push(row.area);
  }
  if (row?.vehicle_id) bits.push(row.vehicle_id);
  if (row?.section) bits.push(row.section);
  const body = bits.join(" · ");
  return { title, body };
}

function desktopNotice(title, body, tag) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const notice = new Notification(title, { body: body || title, tag: tag || "roster-shift" });
    notice.onclick = () => {
      window.focus();
      notice.close();
    };
  } catch {
    /* This browser only shows the in-app toast. */
  }
}

const SIGN_ON_SENT = "roster-signon-sent";
let signOnTimer = 0;
let lateStamp = "";

function sentReminders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIGN_ON_SENT) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function markReminder(key, today) {
  const next = {};
  for (const [id, date] of Object.entries(sentReminders())) {
    if (date === today) next[id] = date;
  }
  next[key] = today;
  try { localStorage.setItem(SIGN_ON_SENT, JSON.stringify(next)); } catch { /* private mode */ }
}

async function showSignOnReminder(tag) {
  const title = "Sign on";
  const body = "Your shift started 20 minutes ago. You still need to sign on.";
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, { body, tag, renotify: false });
    } else {
      const notice = new Notification(title, { body, tag });
      notice.onclick = () => {
        window.focus();
        notice.close();
      };
    }
    toast(body, { duration: 8000, notice: true });
    return true;
  } catch {
    return false;
  }
}

async function todayRowsForCode(code) {
  const today = sydneyToday();
  if (weekDates(state.weekStart).includes(today)) {
    return state.assignments.filter((row) => row.work_date === today && row.officer_code === code);
  }
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("roster_assignments")
    .select("id,work_date,shift,status,is_ot,officer_code,section")
    .eq("work_date", today)
    .eq("officer_code", code);
  if (error) return [];
  return data || [];
}

function signOnRole(code) {
  if (!code) return "";
  if (state.signOnExemptCodes?.has(code)) return "slg";
  if (state.profile?.officer_code === code) return state.profile.role || "";
  return "";
}

async function loadSignOnExemptCodes() {
  const codes = new Set();
  const own = state.profile?.officer_code;
  if (own && signOnRoleWouldExempt(state.profile?.role)) codes.add(own);
  if (supabase) {
    const { data, error } = await supabase.rpc("sign_on_exempt_officer_codes");
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const value = typeof row === "string" ? row : row?.officer_code || row?.sign_on_exempt_officer_codes;
        if (value) codes.add(value);
      }
    }
  }
  state.signOnExemptCodes = codes;
}

function signOnRoleWouldExempt(role) {
  const name = String(role || "").trim().toLowerCase();
  return name === "slg" || name === "roc";
}

async function checkSignOnReminders() {
  const code = state.profile?.officer_code;
  if (!code || !state.user) return;
  if (signOnRoleWouldExempt(state.profile?.role) || state.signOnExemptCodes?.has(code)) return;
  const today = sydneyToday();
  const rows = await todayRowsForCode(code);
  const nowMinutes = sydneyClockMinutes();
  const sent = sentReminders();
  for (const group of groupPlanLines(rows).values()) {
    const items = [...group.byDay.values()].flat();
    const online = presenceOf(code, group.lineKey).status === "online";
    const sign = signOnState({
      items,
      rowShift: items[0].shift,
      online,
      nowMinutes,
      code,
      role: state.profile?.role,
    });
    if (!sign.remind || sign.start == null) continue;
    const key = reminderKey(code, today, `${sign.start}|${group.lineKey}`);
    if (sent[key]) continue;
    const shown = await showSignOnReminder(key);
    if (shown) markReminder(key, today);
  }
}

function visibleLateStamp() {
  if (!isStatusEditor() || (state.view !== "plan" && state.view !== "day")) return "";
  const today = sydneyToday();
  if (!visiblePlanDays().includes(today)) return "";
  const nowMinutes = sydneyClockMinutes();
  const marks = [];
  for (const group of groupPlanLines(state.assignments.filter((row) => row.work_date === today)).values()) {
    const items = group.byDay.get(today) || [];
    const row = items[0];
    if (!row) continue;
    const presence = presenceOf(row.officer_code, group.lineKey);
    const sign = signOnState({
      items,
      rowShift: row.shift,
      online: false,
      nowMinutes,
      code: row.officer_code,
      role: signOnRole(row.officer_code),
    });
    if (sign.late && !lateMarkerCleared(presence) && !exemptFromSignOn({ code: row.officer_code, section: row.section, role: signOnRole(row.officer_code) })) marks.push(row.id);
  }
  marks.sort();
  return marks.join(",");
}

function tickSignOn() {
  checkSignOnReminders();
  const next = visibleLateStamp();
  const changed = next !== lateStamp;
  lateStamp = next;
  if (changed && !cellEditor.open && (state.view === "plan" || state.view === "day")) renderView();
}

let signOnWatching = false;

function watchSignOn() {
  clearInterval(signOnTimer);
  if (!signOnWatching) {
    signOnWatching = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tickSignOn();
    });
  }
  tickSignOn();
  signOnTimer = setInterval(tickSignOn, 30000);
}

function onRosterChange(payload) {
  const eventType = payload?.eventType || payload?.event || "";
  const next = payload?.new && payload.new.id ? payload.new : null;
  const previousId = payload?.old?.id || next?.id;
  const local = state.assignments.find((row) => row.id === previousId) || null;
  const code = state.profile?.officer_code || "";
  let kind = null;
  let row = null;
  if (code && !isLocalEcho()) {
    const wasMine = local?.officer_code === code;
    const isMine = next?.officer_code === code;
    if (eventType === "DELETE") {
      if (!isRosterEditor() || wasMine) {
        kind = "removed";
        row = local || { id: previousId };
      }
    } else if (eventType === "INSERT" && (!isRosterEditor() || isMine)) {
      kind = "added";
      row = next;
    } else if (eventType === "UPDATE" && next) {
      if (wasMine && next.officer_code && next.officer_code !== code) {
        kind = "removed";
        row = local;
      } else if (!isRosterEditor() || isMine) {
        kind = "updated";
        row = { ...local, ...next };
      }
    }
  }
  if (kind && row) {
    if (kind !== "removed" && row.id) state.unread.add(row.id);
    const copy = shiftChangeCopy(kind, row);
    const detail = copy.body && copy.body !== copy.title ? ` — ${copy.body}` : "";
    toast(`${copy.title}${detail}`, { duration: 7000, notice: true });
    desktopNotice(copy.title, copy.body, row.id);
  }
  scheduleReload();
}

function subscribeRoster() {
  if (!supabase || rosterChannel) return;
  rosterChannel = supabase
    .channel("roster-assignments-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "roster_assignments" }, onRosterChange)
    .subscribe();
  presenceChannel = supabase
    .channel("roster-officer-status-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "roster_officer_status" }, schedulePresence)
    .subscribe();
}

function unsubscribeRoster() {
  clearTimeout(reloadTimer);
  clearTimeout(presenceTimer);
  if (rosterChannel && supabase) supabase.removeChannel(rosterChannel);
  if (presenceChannel && supabase) supabase.removeChannel(presenceChannel);
  rosterChannel = null;
  presenceChannel = null;
}

async function loadPresence() {
  const seq = ++presenceSeq;
  const { data, error } = await supabase
    .from("roster_officer_status")
    .select("officer_code,line_key,status,note,updated_at,online_unlocked_on,signed_line")
    .limit(2000);
  if (seq !== presenceSeq) return;
  if (error) {
    toast("Radio status didn’t load. The week plan is still here.");
    return;
  }
  const next = {};
  for (const row of data || []) {
    const line = row.line_key || row.signed_line || "";
    if (!row.officer_code || !line) continue;
    if (!next[row.officer_code]) next[row.officer_code] = {};
    next[row.officer_code][line] = row;
  }
  state.presence = next;
  renderView();
}

function schedulePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    if (document.activeElement?.matches?.("[data-presence-note], #presence-menu-note")) return;
    loadPresence();
  }, 150);
}

async function savePresence(code, status, note, { toastOk = true, line } = {}) {
  if (!code || !PRESENCE[status] || !state.user) return false;
  if (!isStatusEditor() && code !== state.profile?.officer_code) {
    toast("You can only change your own radio status.");
    return false;
  }
  const lineKey = String(line || "").trim();
  if (!lineKey) return false;
  const unlocked = presenceOf(code, lineKey).unlocked;
  if (!isStatusEditor() && !unlocked) {
    toast("Radio dispatch signs you on as Online or Office.");
    return false;
  }
  if (isStatusEditor() && !unlocked && !SIGN_ON_STATUSES.includes(status)) {
    toast("Sign on as Online or Office first.");
    return false;
  }
  const previous = state.presence[code]?.[lineKey] || {};
  const payload = {
    officer_code: code,
    line_key: lineKey,
    status,
    note: note ? String(note).trim().slice(0, 200) : null,
    updated_at: new Date().toISOString(),
    updated_by: state.user.id,
    signed_line: lineKey,
  };
  if (isStatusEditor() && SIGN_ON_STATUSES.includes(status)) payload.online_unlocked_on = sydneyToday();
  else if (previous.online_unlocked_on) payload.online_unlocked_on = previous.online_unlocked_on;
  state.presence = {
    ...state.presence,
    [code]: { ...(state.presence[code] || {}), [lineKey]: payload },
  };
  renderView();
  const { error } = await supabase.from("roster_officer_status").upsert(payload, { onConflict: "officer_code,line_key" });
  if (error) {
    toast(friendlyError(error));
    loadPresence();
    return false;
  }
  if (toastOk) {
    const label = PRESENCE[status].label;
    toast(code === state.profile?.officer_code ? `Radio status: ${label}` : `${officerByCode(code)?.name || code} · ${label}`);
  }
  return true;
}

function placePresenceMenu(anchor) {
  const pop = $("presence-menu");
  const margin = 8;
  const width = pop.offsetWidth || 260;
  const height = pop.offsetHeight || 220;
  let left = 16;
  let top = 80;
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
  }
  pop.style.left = `${Math.max(margin, Math.round(left))}px`;
  pop.style.top = `${Math.max(margin, Math.round(top))}px`;
}

function closePresenceMenu() {
  presenceMenu.code = "";
  presenceMenu.line = "";
  const pop = $("presence-menu");
  if (pop) pop.hidden = true;
}

function closeContact() {
  const pop = $("contact-pop");
  if (pop) pop.hidden = true;
}

function openContact(code, anchor) {
  const officer = officerByCode(code);
  const name = officer?.name || anchor?.textContent || code || "Officer";
  const phone = (officer?.contact || "").trim();
  const channel = (officer?.radio || "").trim();
  $("contact-name").textContent = name;
  $("contact-meta").textContent = [code, channel && `Radio ${channel}`].filter(Boolean).join(" · ");
  const link = $("contact-phone");
  if (phone) {
    const tel = phone.replace(/[^\d+]/g, "");
    link.hidden = false;
    link.href = tel ? `tel:${tel}` : "#";
    link.textContent = phone;
    $("contact-empty").hidden = true;
  } else {
    link.hidden = true;
    link.removeAttribute("href");
    $("contact-empty").hidden = false;
  }
  $("contact-pop").hidden = false;
  const pop = $("contact-pop");
  const margin = 8;
  const rect = anchor?.getBoundingClientRect?.();
  let left = rect ? rect.left : 16;
  let top = rect ? rect.bottom + 4 : 80;
  const width = pop.offsetWidth || 240;
  const height = pop.offsetHeight || 140;
  if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, (rect?.top || 80) - height - 4);
  pop.style.left = `${Math.max(margin, Math.round(left))}px`;
  pop.style.top = `${Math.max(margin, Math.round(top))}px`;
}

function openPresenceMenu(code, anchor) {
  if (!code) return;
  const own = code === state.profile?.officer_code;
  if (!isStatusEditor() && !own) return;
  const lineKey = anchor?.dataset?.line || "";
  const current = presenceOf(code, lineKey);
  presenceMenu.code = code;
  presenceMenu.line = lineKey;
  const name = anchor?.closest?.("tr")?.querySelector(".who-name")?.textContent || officerByCode(code)?.name || code;
  $("presence-menu-title").textContent = name;
  $("presence-menu-note").value = current.note;
  const choices = document.querySelector("#presence-menu .presence-choices");
  if (choices) {
    choices.innerHTML = presenceIds(current.unlocked).map((id) => {
      const active = current.unlocked && id === current.status;
      const disabled = !current.unlocked && !isStatusEditor();
      return `<button type="button" class="presence-choice presence-${id}${active ? " is-active" : ""}" data-menu-presence="${id}"${disabled ? " disabled" : ""}>${escapeHtml(PRESENCE[id].label)}</button>`;
    }).join("");
  }
  const menuLock = $("presence-menu-lock");
  if (menuLock) {
    menuLock.hidden = current.unlocked;
    menuLock.textContent = isStatusEditor()
      ? "Sign on as Online or Office."
      : "Radio dispatch signs you on as Online or Office.";
  }
  $("presence-menu").hidden = false;
  placePresenceMenu(anchor);
}

function showCellError(message) {
  $("cell-error").hidden = false;
  $("cell-error").textContent = message;
}

function readCellForm() {
  const code = $("c-code").value.trim();
  const officer = officerByCode(code);
  const values = {
    work_date: $("c-date").value,
    section: $("c-section").value,
    officer_id: officer?.id || null,
    officer_code: code || null,
    shift: $("c-shift").value.trim() || null,
    function: $("c-function").value.trim() || null,
    vehicle_id: $("c-vehicle").value.trim() || null,
    peak: $("c-peak").value.trim() || null,
    area: $("c-area").value.trim() || null,
    notes: $("c-notes").value.trim() || null,
    status: $("c-status").value,
    is_ot: false,
  };
  const overtime = ($("c-ot").checked || values.status === "ot") && values.status !== "sick";
  values.is_ot = overtime;
  if (overtime && (values.status === "draft" || values.status === "published")) values.status = "ot";
  if (!overtime && values.status === "ot") values.status = "published";
  if (values.status === "sick") values.is_ot = false;
  return values;
}

function tickedDays(root, fallbackDate) {
  if (!root) return fallbackDate ? [fallbackDate] : [];
  const boxes = [...root.querySelectorAll("input[type=checkbox]")];
  if (!boxes.length) return fallbackDate ? [fallbackDate] : [];
  return boxes.filter((box) => box.checked).map((box) => box.value);
}

function renderCopyDays(row, anchorDate) {
  if (!row) return;
  const weekStart = isValidISODate(anchorDate) ? mondayOf(anchorDate) : state.weekStart;
  if (!weekStart) return;
  const days = weekDates(weekStart);
  const anchor = days.includes(anchorDate) ? anchorDate : days[0];
  row.innerHTML = days.map((iso) => {
    const label = formatDayShort(iso).dow;
    const checked = iso === anchor ? " checked" : "";
    return `<label><input type="checkbox" value="${iso}"${checked}> ${escapeHtml(label)}</label>`;
  }).join("");
}

function ensureFormCopyDays() {
  const row = $("form-copy-day-row");
  if (!row || !state.weekStart) return;
  const anchor = isValidISODate($("f-date").value) ? $("f-date").value : state.weekStart;
  const wanted = mondayOf(anchor);
  const first = row.querySelector("input")?.value;
  if (first === wanted) return;
  renderCopyDays(row, anchor);
  $("f-date").dataset.prev = $("f-date").value || anchor;
}

function followCopyDate(root, row, previous, next) {
  if (!isValidISODate(next)) return;
  const boxes = root ? [...root.querySelectorAll("input[type=checkbox]")] : [];
  const known = boxes.some((box) => box.value === next);
  if (!known && row) {
    const ticked = boxes.filter((box) => box.checked);
    const sole = !ticked.length || (ticked.length === 1 && ticked[0].value === previous);
    if (sole) {
      renderCopyDays(row, next);
      return;
    }
  }
  shiftDateTick(root, previous, next);
}

function shiftDateTick(root, previous, next) {
  if (!root) return;
  const boxes = [...root.querySelectorAll("input[type=checkbox]")];
  const nextBox = boxes.find((box) => box.value === next);
  if (!nextBox) return;
  const ticked = boxes.filter((box) => box.checked);
  const soleMove = previous && ticked.length === 1 && ticked[0].value === previous;
  if (soleMove) boxes.forEach((box) => { box.checked = box.value === next; });
  else nextBox.checked = true;
}

function cellSnapshot(values) {
  return JSON.stringify({ values, days: tickedDays($("copy-days"), values.work_date) });
}

function syncSickRange(date, { reset = false } = {}) {
  const box = $("sick-range");
  if (!box) return;
  const sick = $("c-status").value === "sick";
  box.hidden = !sick;
  if (!sick || !state.weekStart) return;
  const start = state.weekStart;
  const end = addDays(start, 6);
  $("c-sick-from").min = start;
  $("c-sick-from").max = end;
  $("c-sick-to").min = start;
  $("c-sick-to").max = end;
  const picked = isValidISODate(date) && date >= start && date <= end ? date : start;
  if (reset || !$("c-sick-from").value) $("c-sick-from").value = picked;
  if (reset || !$("c-sick-to").value) $("c-sick-to").value = picked;
}

function datesInclusive(from, to) {
  if (!isValidISODate(from) || !isValidISODate(to)) return [];
  let cursor = from <= to ? from : to;
  const end = from <= to ? to : from;
  const days = [];
  for (let guard = 0; guard < 8 && cursor <= end; guard += 1) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

async function applySickRange(values) {
  if (values.status !== "sick" || !values.officer_code || !state.weekStart) return null;
  const start = state.weekStart;
  const end = addDays(start, 6);
  const days = datesInclusive($("c-sick-from").value, $("c-sick-to").value)
    .filter((day) => day !== values.work_date && day >= start && day <= end);
  for (const day of days) {
    const existing = state.assignments.filter((row) => row.work_date === day && row.officer_code === values.officer_code && row.section === values.section && !isOt(row));
    if (existing.length) {
      for (const row of existing) {
        const { error } = await supabase.from("roster_assignments").update({ status: "sick", updated_at: new Date().toISOString() }).eq("id", row.id);
        if (error) return error;
      }
    } else {
      const { error } = await supabase.from("roster_assignments").insert({
        work_date: day,
        section: values.section,
        officer_id: values.officer_id,
        officer_code: values.officer_code,
        shift: values.shift,
        function: values.function,
        vehicle_id: values.vehicle_id,
        peak: values.peak,
        area: values.area,
        status: "sick",
        is_ot: false,
        created_by: state.user.id,
      });
      if (error) return error;
    }
  }
  return null;
}

function cellIsBlank(values) {
  return !values.officer_code && !values.shift && !values.function && !values.vehicle_id && !values.peak && !values.area && !values.notes;
}

function syncCellKicker() {
  const date = $("c-date").value;
  const section = $("c-section").value || "FS";
  const day = isValidISODate(date) ? formatDayHeading(date) : "Date";
  $("cell-editor-kicker").textContent = `${day} · ${section}`;
}

function placeCellEditor(anchor) {
  const pop = $("cell-editor");
  const margin = 8;
  const width = pop.offsetWidth || 320;
  const height = pop.offsetHeight || 420;
  let left = 16;
  let top = 80;
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
  }
  pop.style.left = `${Math.max(margin, Math.round(left))}px`;
  pop.style.top = `${Math.max(margin, Math.round(top))}px`;
}

function closeCellEditor({ flush = true } = {}) {
  cellEditor.open = false;
  cellEditor.id = null;
  cellEditor.saving = false;
  cellEditor.anchor = null;
  cellEditor.snapshot = "";
  const pop = $("cell-editor");
  if (pop) pop.hidden = true;
  if (flush) flushReload();
}

function openCellEditor(row, preset = {}, anchor = null) {
  if (!isRosterEditor() || weekLocked()) return;
  cellEditor.open = true;
  cellEditor.id = row?.id || null;
  cellEditor.saving = false;
  cellEditor.anchor = anchor || null;
  cellEditor.next = null;
  $("cell-error").hidden = true;
  $("cell-clear-ask").hidden = true;
  $("cell-clear").hidden = !row;
  $("cell-editor-title").textContent = row ? "Edit shift" : "New shift";
  const date = row?.work_date || preset.date || visiblePlanDays()[0] || state.weekStart;
  const section = SECTION_IDS.has(row?.section || preset.section) ? (row?.section || preset.section) : "FS";
  $("c-date").value = date;
  $("c-section").value = section;
  $("c-code").value = row?.officer_code || preset.officer_code || "";
  $("c-shift").value = row?.shift || preset.shift || "";
  $("c-function").value = row?.function || preset.function || "";
  $("c-vehicle").value = row?.vehicle_id || preset.vehicle_id || "";
  $("c-peak").value = row?.peak || preset.peak || "";
  $("c-area").value = row?.area || "";
  $("c-notes").value = row?.notes || "";
  const overtime = row ? isOt(row) : !!preset.ot;
  $("c-status").value = row && STATUS_LABEL[row.status] ? row.status : (overtime ? "ot" : "draft");
  $("c-ot").checked = overtime;
  if (overtime && ($("c-status").value === "draft" || $("c-status").value === "published")) $("c-status").value = "ot";
  syncSickRange(date, { reset: true });
  $("cell-add-ot").hidden = overtime;
  renderCopyDays($("copy-day-row"), date);
  cellEditor.lastDate = date;
  syncCellKicker();
  cellEditor.snapshot = cellSnapshot(readCellForm());
  $("cell-editor").hidden = false;
  placeCellEditor(anchor);
  $("c-code").focus();
  requestAnimationFrame(() => {
    if (cellEditor.open) placeCellEditor(anchor);
  });
}

function presetFromAdd(button) {
  return {
    date: button.dataset.date,
    section: button.dataset.section,
    officer_code: button.dataset.code || "",
    shift: button.dataset.shift || "",
    vehicle_id: button.dataset.vehicle || "",
    function: button.dataset.function || "",
    ot: button.dataset.ot === "1",
  };
}

function queueOtLine() {
  const values = readCellForm();
  if (!values.officer_code) {
    showCellError("Set the officer code first, then add the overtime line.");
    return;
  }
  cellEditor.next = {
    type: "add",
    preset: {
      date: values.work_date,
      section: values.section,
      officer_code: values.officer_code,
      function: values.function,
      vehicle_id: values.vehicle_id,
      ot: true,
    },
  };
  commitCellEditor();
}

function dayWritePayload(values, day, { notes } = {}) {
  const payload = {
    work_date: day,
    section: values.section,
    officer_id: values.officer_id,
    officer_code: values.officer_code,
    shift: values.shift,
    function: values.function,
    vehicle_id: values.vehicle_id,
    peak: values.peak,
    area: values.area,
    status: values.status,
    is_ot: !!values.is_ot,
    updated_at: new Date().toISOString(),
  };
  if (notes !== undefined) payload.notes = notes;
  return payload;
}

async function saveTickedDays(values, { editingId, root }) {
  const picked = tickedDays(root, values.work_date).filter((day) => isValidISODate(day));
  if (!picked.length) return { error: { message: "Tick at least one day this week." } };
  const weekMonday = mondayOf(picked[0]);
  const days = picked.filter((day) => mondayOf(day) === weekMonday);
  const original = editingId ? state.assignments.find((row) => row.id === editingId) : null;
  const moving = !!(original && !days.includes(original.work_date) && days.length === 1);
  const used = new Set();
  for (const day of days) {
    let existing = null;
    if (original && original.work_date === day && !used.has(original.id)) existing = original;
    if (!existing) {
      existing = officerDayTarget(state.assignments, {
        day,
        officerCode: values.officer_code,
        officerId: values.officer_id,
        section: values.section,
        ot: values.is_ot,
        preferId: original?.id,
        excludeIds: used,
      });
    }
    if (!existing && moving && original && !used.has(original.id)) existing = original;
    const opened = !!(existing && original && existing.id === original.id);
    const payload = dayWritePayload(values, day, opened ? { notes: values.notes ?? null } : {});
    if (existing) {
      used.add(existing.id);
      const { error } = await supabase.from("roster_assignments").update(payload).eq("id", existing.id);
      if (error) return { error };
      existing.work_date = day;
      Object.assign(existing, payload);
    } else {
      const { data, error } = await supabase.from("roster_assignments").insert({ ...payload, created_by: state.user.id }).select("id").single();
      if (error) return { error };
      if (data?.id) {
        used.add(data.id);
        state.assignments = [...state.assignments, { ...payload, id: data.id }];
      }
    }
  }
  return { error: null, count: days.length, days };
}

async function persistCell(values) {
  if (!isValidISODate(values.work_date)) {
    showCellError("Choose a valid date.");
    return false;
  }
  if (!SECTION_IDS.has(values.section)) {
    showCellError("Choose a section from the list.");
    return false;
  }
  cellEditor.saving = true;
  $("cell-save").disabled = true;
  beginLocalEcho();
  const editingId = cellEditor.id;
  const saved = await saveTickedDays(values, { editingId, root: $("copy-days") });
  $("cell-save").disabled = false;
  cellEditor.saving = false;
  if (saved.error) {
    showCellError(saved.error.message && !saved.error.code ? saved.error.message : friendlyError(saved.error));
    return false;
  }
  const rangeError = await applySickRange(values);
  if (rangeError) {
    showCellError(friendlyError(rangeError));
    return false;
  }
  const savedDate = saved.days?.includes(values.work_date) ? values.work_date : (saved.days?.[0] || values.work_date);
  const next = cellEditor.next;
  cellEditor.next = null;
  closeCellEditor({ flush: false });
  toast(saved.count > 1 ? `Shift saved on ${saved.count} days` : (editingId ? "Shift saved" : "Shift added"));
  if (mondayOf(savedDate) !== state.weekStart) setWeek(savedDate, { keepOffset: false });
  else await loadAssignments({ silent: true });
  if (next) followCellTarget(next);
  return true;
}

async function clearCell() {
  const id = cellEditor.id;
  if (!id || cellEditor.saving) return;
  cellEditor.saving = true;
  beginLocalEcho();
  const { data, error } = await supabase.from("roster_assignments").delete().eq("id", id).select("id");
  cellEditor.saving = false;
  if (error || !data?.length) {
    showCellError(error ? friendlyError(error) : "That line is already gone, or you can’t remove it.");
    $("cell-clear-ask").hidden = true;
    return;
  }
  closeCellEditor({ flush: false });
  toast("Shift cleared");
  loadAssignments({ silent: true });
}

function followCellTarget(target) {
  if (!target || !isRosterEditor()) return;
  if (target.type === "add") openCellEditor(null, target.preset, target.anchor);
  if (target.type === "open") {
    const row = state.assignments.find((item) => item.id === target.id);
    if (row) openCellEditor(row, {}, target.anchor);
  }
}

async function commitCellEditor() {
  if (!cellEditor.open || cellEditor.saving) return;
  const next = cellEditor.next;
  const values = readCellForm();
  const dirty = cellSnapshot(values) !== cellEditor.snapshot;
  if (!dirty || (!cellEditor.id && cellIsBlank(values))) {
    cellEditor.next = null;
    closeCellEditor();
    if (next) followCellTarget(next);
    return;
  }
  cellEditor.next = next;
  await persistCell(values);
}

function bind() {
  $("toggle-password").addEventListener("click", () => {
    const input = $("password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggle-password").textContent = show ? "Hide" : "Show";
    $("toggle-password").setAttribute("aria-pressed", show ? "true" : "false");
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("login-submit");
    button.disabled = true;
    button.textContent = "Signing in…";
    $("login-error").hidden = true;
    const { error } = await supabase.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });
    button.disabled = false;
    button.textContent = "Sign in";
    if (error) {
      $("login-error").hidden = false;
      $("login-error").textContent = error.message === "Invalid login credentials"
        ? "That email and password didn’t match a Parking Project account."
        : friendlyError(error);
    }
  });

  $("show-magic").addEventListener("click", () => {
    $("magic-form").hidden = !$("magic-form").hidden;
    if (!$("magic-email").value) $("magic-email").value = $("email").value;
    $("magic-email").focus();
  });

  $("magic-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("magic-submit");
    button.disabled = true;
    const email = $("magic-email").value.trim();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${location.origin}${location.pathname}`,
      },
    });
    button.disabled = false;
    const status = $("magic-status");
    status.hidden = false;
    if (error) {
      status.className = "banner error";
      status.textContent = friendlyError(error);
      return;
    }
    status.className = "banner ok";
    status.textContent = "If that email has an account, a sign-in link is on its way. Open it on this device.";
  });

  $("sign-out").addEventListener("click", () => {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    supabase.auth.signOut();
  });
  $("prev-week").addEventListener("click", () => stepWeek(-1));
  $("next-week").addEventListener("click", () => stepWeek(1));
  $("this-week").addEventListener("click", () => {
    const today = sydneyToday();
    state.board = "live";
    state.planSpan = defaultSpan(mondayOf(today));
    state.focusDay = today;
    setWeek(today, { keepOffset: false });
  });
  $("refresh").addEventListener("click", async () => {
    if (state.view === "officers") {
      await loadDirectories();
      renderView();
      return;
    }
    await autoArchivePastWeeks();
    loadAssignments();
  });
  $("board-toggle").addEventListener("click", (event) => {
    const button = event.target.closest("[data-board]");
    if (!button) return;
    setBoard(button.dataset.board);
  });
  $("archive-week").addEventListener("click", () => setWeekArchived(true));
  $("restore-week").addEventListener("click", () => setWeekArchived(false));
  $("add-assignment").addEventListener("click", () => {
    const days = visiblePlanDays();
    openCellEditor(null, { date: days[0] || state.weekStart, section: "FS" }, $("add-assignment"));
  });

  document.querySelector(".tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    setView(button.dataset.view);
  });

  $("filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.statusFilter = button.dataset.filter;
    renderView();
  });

  $("plan-query").addEventListener("input", () => {
    state.planQuery = $("plan-query").value;
    $("plan-query-clear").hidden = !state.planQuery.trim();
    renderView();
  });
  $("plan-query").addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.planQuery) return;
    state.planQuery = "";
    $("plan-query").value = "";
    renderView();
  });
  $("plan-query-clear").addEventListener("click", () => {
    state.planQuery = "";
    $("plan-query").value = "";
    $("plan-query").focus();
    renderView();
  });

  document.querySelector(".toolbar").addEventListener("click", (event) => {
    const span = event.target.closest("[data-span]");
    if (span) {
      state.planSpan = span.dataset.span === "weekend" ? "weekend" : "weekday";
      renderView();
      return;
    }
    const density = event.target.closest("[data-density]");
    if (!density) return;
    state.density = density.dataset.density === "comfortable" ? "comfortable" : "compact";
    try { localStorage.setItem("roster-density", state.density); } catch { /* private mode */ }
    renderView();
  });

  $("view").addEventListener("focusout", (event) => {
    const input = event.target.closest?.("[data-presence-note]");
    if (!input) return;
    if (event.relatedTarget?.closest?.("[data-set-presence]")) return;
    const code = state.profile?.officer_code;
    if (!code) return;
    const note = input.value.trim();
    const lineKey = input.dataset.line || "";
    const current = presenceOf(code, lineKey);
    if ((current.note || "") === note) return;
    savePresence(code, current.status, note, { toastOk: false, line: lineKey });
  });

  $("view").addEventListener("input", (event) => {
    const query = event.target.closest?.("[data-officer-query]");
    if (!query) return;
    state.officerQuery = query.value;
    const needle = state.officerQuery.trim().toLowerCase();
    document.querySelectorAll("[data-officer-row]").forEach((row) => {
      row.hidden = !!needle && !row.textContent.toLowerCase().includes(needle);
    });
  });

  $("view").addEventListener("submit", async (event) => {
    const officerForm = event.target.closest?.("form[data-officer-form]");
    if (officerForm) {
      event.preventDefault();
      await saveOfficer(officerForm);
      return;
    }
    const form = event.target.closest?.("form[data-dispatcher]");
    if (!form) return;
    event.preventDefault();
    if (!isStatusEditor()) return;
    const workDate = form.dataset.dispatcher;
    const name = form.elements["dispatcher-name"].value.trim().slice(0, 80);
    const note = form.elements["dispatcher-note"].value.trim().slice(0, 80);
    const payload = {
      work_date: workDate,
      name,
      note: note || null,
      updated_at: new Date().toISOString(),
      updated_by: state.user.id,
    };
    state.dispatchers = { ...state.dispatchers, [workDate]: payload };
    renderView();
    const { error } = await supabase.from("roster_dispatcher").upsert(payload, { onConflict: "work_date" });
    if (error) {
      toast(friendlyError(error));
      loadAssignments({ silent: true });
      return;
    }
    toast("Dispatcher saved");
  });

  $("view").addEventListener("click", (event) => {
    if (event.target.closest("[data-officer-add]")) {
      state.officerDraft = { id: null };
      renderView();
      document.querySelector(".officer-form input[name=name]")?.focus();
      return;
    }
    if (event.target.closest("[data-officer-cancel]")) {
      state.officerDraft = null;
      renderView();
      return;
    }
    const editOfficer = event.target.closest("[data-officer-edit]");
    if (editOfficer) {
      state.officerDraft = { id: editOfficer.dataset.officerEdit };
      renderView();
      document.querySelector(".officer-form input[name=name]")?.focus();
      return;
    }
    if (event.target.closest("[data-officer-deactivate]")) {
      const form = document.querySelector("form[data-officer-form]");
      if (form) saveOfficer(form, { active: false });
      return;
    }
    const officerFilter = event.target.closest("[data-officer-filter]");
    if (officerFilter) {
      state.officerFilter = officerFilter.dataset.officerFilter;
      renderView();
      return;
    }
    const addOt = event.target.closest("[data-add-ot]");
    if (addOt) {
      if (weekLocked()) return;
      const days = visiblePlanDays();
      const today = sydneyToday();
      const code = addOt.dataset.code;
      const section = addOt.dataset.section;
      const taken = new Set(state.assignments.filter((row) => isOt(row) && row.officer_code === code && row.section === section).map((row) => row.work_date));
      const date = days.includes(today) && !taken.has(today) ? today : (days.find((day) => !taken.has(day)) || addOt.dataset.date);
      const existing = state.assignments.find((row) => isOt(row) && row.officer_code === code && row.section === section && row.work_date === date);
      if (existing) openCellEditor(existing, {}, addOt);
      else openCellEditor(null, {
        date,
        section,
        officer_code: code,
        function: addOt.dataset.function || "",
        vehicle_id: addOt.dataset.vehicle || "",
        ot: true,
      }, addOt);
      return;
    }
    const choice = event.target.closest("[data-set-presence]");
    if (choice) {
      const note = choice.parentElement?.parentElement?.querySelector("[data-presence-note]")?.value.trim() || "";
      savePresence(state.profile?.officer_code, choice.dataset.setPresence, note, { line: choice.dataset.line || "" });
      return;
    }
    const chip = event.target.closest("[data-presence]");
    if (chip) {
      openPresenceMenu(chip.dataset.presence, chip);
      return;
    }
    const contact = event.target.closest("[data-contact]");
    if (contact) {
      openContact(contact.dataset.contact, contact);
      return;
    }
    if (event.target.closest("[data-retry]")) {
      loadAssignments();
      return;
    }
    const toggle = event.target.closest("[data-toggle-section]");
    if (toggle) {
      toggleSection(toggle.dataset.toggleSection);
      return;
    }
    const dayStep = event.target.closest("[data-day-step]");
    if (dayStep && !dayStep.disabled) {
      const days = weekDates(state.weekStart);
      const next = days[days.indexOf(selectedDay()) + Number(dayStep.dataset.dayStep)];
      if (next) setFocusDay(next);
      return;
    }
    const pickDay = event.target.closest("[data-pick-day]");
    if (pickDay) {
      setFocusDay(pickDay.dataset.pickDay);
      return;
    }
    const offset = event.target.closest("[data-offset]");
    if (offset) {
      state.focusOffset = Number(offset.dataset.offset);
      renderView();
      return;
    }
    const span = event.target.closest("[data-span]");
    if (span) {
      state.planSpan = span.dataset.span === "weekend" ? "weekend" : "weekday";
      renderView();
      return;
    }
    const add = event.target.closest("[data-add]");
    if (add) {
      if (cellEditor.open && cellEditor.anchor === add) return;
      openCellEditor(null, presetFromAdd(add), add);
      return;
    }
    const open = event.target.closest("[data-open]");
    if (open) {
      if (cellEditor.open && cellEditor.anchor === open) return;
      const row = state.assignments.find((item) => item.id === open.dataset.open);
      if (!row) return;
      if (!isRosterEditor() && state.unread.delete(row.id)) {
        open.classList.remove("is-unread");
        open.querySelector(".badge.updated")?.remove();
      }
      if (isRosterEditor() && !weekLocked()) openCellEditor(row, {}, open);
      else openModal(row);
    }
  });

  $("app-banner").addEventListener("click", (event) => {
    if (event.target.closest("[data-retry]")) loadAssignments();
    if (event.target.closest("[data-notify-allow]")) allowNotices();
    if (event.target.closest("[data-notify-dismiss]")) {
      try { localStorage.setItem("roster-notify", "dismissed"); } catch { /* private mode */ }
      renderView();
    }
  });

  $("f-officer").addEventListener("change", () => {
    const officer = officerById($("f-officer").value);
    if (officer) $("f-code").value = officer.code;
    updateOfficerMeta();
  });
  $("f-code").addEventListener("input", updateOfficerMeta);
  $("assignment-form").addEventListener("submit", saveAssignment);
  $("modal-close").addEventListener("click", closeModal);
  $("modal-cancel").addEventListener("click", closeModal);
  $("read-close").addEventListener("click", closeModal);
  $("delete-assignment").addEventListener("click", () => {
    $("delete-confirm").hidden = false;
  });
  $("delete-keep").addEventListener("click", () => {
    $("delete-confirm").hidden = true;
  });
  $("delete-confirm-btn").addEventListener("click", removeAssignment);

  $("cell-form").addEventListener("submit", (event) => {
    event.preventDefault();
    cellEditor.next = null;
    commitCellEditor();
  });
  $("cell-cancel").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cellEditor.next = null;
    closeCellEditor();
  });
  $("cell-clear").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  $("cell-clear").addEventListener("click", () => {
    $("cell-clear-ask").hidden = false;
  });
  $("cell-clear-no").addEventListener("click", () => {
    $("cell-clear-ask").hidden = true;
  });
  $("cell-clear-yes").addEventListener("click", clearCell);
  $("c-date").addEventListener("input", () => {
    followCopyDate($("copy-days"), $("copy-day-row"), cellEditor.lastDate, $("c-date").value);
    cellEditor.lastDate = $("c-date").value;
    syncCellKicker();
  });
  $("f-date").addEventListener("input", () => {
    followCopyDate($("form-copy-days"), $("form-copy-day-row"), $("f-date").dataset.prev || "", $("f-date").value);
    $("f-date").dataset.prev = $("f-date").value;
  });
  $("c-section").addEventListener("change", syncCellKicker);
  $("c-ot").addEventListener("change", () => {
    if ($("c-ot").checked && ($("c-status").value === "draft" || $("c-status").value === "published")) $("c-status").value = "ot";
    if (!$("c-ot").checked && $("c-status").value === "ot") $("c-status").value = "published";
    $("cell-add-ot").hidden = $("c-ot").checked;
  });
  $("c-status").addEventListener("change", () => {
    if ($("c-status").value === "ot") $("c-ot").checked = true;
    if ($("c-status").value === "sick") $("c-ot").checked = false;
    $("cell-add-ot").hidden = $("c-ot").checked || $("c-status").value === "ot";
    syncSickRange($("c-date").value);
  });
  $("cell-add-ot").addEventListener("click", queueOtLine);
  $("cell-editor").addEventListener("focusout", (event) => {
    if (!cellEditor.open || cellEditor.saving) return;
    const next = event.relatedTarget;
    if (next && $("cell-editor").contains(next)) return;
    setTimeout(() => {
      if (!cellEditor.open || cellEditor.saving) return;
      commitCellEditor();
    }, 0);
  });

  document.addEventListener("pointerdown", (event) => {
    if (!cellEditor.open || cellEditor.saving) return;
    const pop = $("cell-editor");
    if (pop.contains(event.target)) return;
    if (cellEditor.anchor && (event.target === cellEditor.anchor || cellEditor.anchor.contains?.(event.target))) return;
    const add = event.target.closest("[data-add]");
    const open = event.target.closest("[data-open]");
    if (add) cellEditor.next = { type: "add", preset: presetFromAdd(add), anchor: add };
    else if (open && isRosterEditor()) cellEditor.next = { type: "open", id: open.dataset.open, anchor: open };
    else cellEditor.next = null;
    if (cellEditor.next) event.preventDefault();
    commitCellEditor();
  }, true);

  window.addEventListener("resize", () => {
    if (cellEditor.open) placeCellEditor(cellEditor.anchor);
  });
  document.addEventListener("scroll", () => {
    if (cellEditor.open) placeCellEditor(cellEditor.anchor);
  }, true);

  $("presence-menu").addEventListener("click", async (event) => {
    const choice = event.target.closest("[data-menu-presence]");
    if (!choice || !presenceMenu.code) return;
    const ok = await savePresence(presenceMenu.code, choice.dataset.menuPresence, $("presence-menu-note").value.trim(), { line: presenceMenu.line });
    if (ok) closePresenceMenu();
  });
  $("presence-menu-close").addEventListener("click", closePresenceMenu);
  $("contact-close").addEventListener("click", closeContact);
  $("presence-menu-note").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !presenceMenu.code) return;
    event.preventDefault();
    const current = presenceOf(presenceMenu.code, presenceMenu.line);
    savePresence(presenceMenu.code, current.status, event.target.value.trim(), { toastOk: false, line: presenceMenu.line });
  });

  document.addEventListener("pointerdown", (event) => {
    const contactPop = $("contact-pop");
    if (contactPop && !contactPop.hidden && !contactPop.contains(event.target) && !event.target.closest?.("[data-contact]")) closeContact();
    const pop = $("presence-menu");
    if (!pop || pop.hidden) return;
    if (pop.contains(event.target) || event.target.closest?.("[data-presence]")) return;
    closePresenceMenu();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("presence-menu").hidden) {
      closePresenceMenu();
      return;
    }
    if (!$("contact-pop").hidden) {
      closeContact();
      return;
    }
    if (cellEditor.open) {
      cellEditor.next = null;
      closeCellEditor();
      return;
    }
    if (!$("modal").hidden) closeModal();
  });

  window.addEventListener("hashchange", () => {
    if (!state.user) return;
    const raw = location.hash;
    if (raw.includes("access_token=") || raw.includes("error=")) return;
    const route = readRoute();
    const week = route.week || state.weekStart;
    const viewChanged = route.view !== state.view;
    const bounded = week > addDays(thisMonday(), 7) ? addDays(thisMonday(), 7) : week;
    const weekChanged = bounded !== state.weekStart;
    const dayChanged = route.day && route.day !== state.focusDay;
    state.deniedPlan = false;
    if (route.view === "officers" && !isOfficerAdmin()) {
      state.deniedPlan = true;
      state.view = "my-week";
    } else if (route.view === "day") {
      state.view = "day";
    } else if (route.view === "plan") {
      state.view = "plan";
    } else if (route.view === "officers") {
      state.view = "officers";
    } else {
      state.view = "my-week";
    }
    state.weekStart = bounded;
    if (route.day && weekDates(bounded).includes(route.day)) state.focusDay = route.day;
    else if (weekChanged || !weekDates(bounded).includes(state.focusDay)) state.focusDay = defaultDay(bounded);
    if (plannerGrid()) state.board = bounded < thisMonday() ? "archive" : "live";
    if (weekChanged) loadAssignments();
    else if (viewChanged || dayChanged) renderView();
  });
}

async function start() {
  bind();
  let config;
  try {
    config = await loadConfig();
  } catch {
    config = null;
  }
  if (!config || typeof createClient !== "function") {
    show("boot", false);
    show("screen-login", true);
    $("config-error").hidden = false;
    $("config-error").innerHTML = typeof createClient !== "function"
      ? "<p><strong>Supabase client missing.</strong> js/vendor/supabase.js did not load.</p>"
      : "<p><strong>Config missing.</strong> Copy <code>js/config.example.js</code> to <code>js/config.js</code> and set the Parking Project URL and anon key.</p>";
    $("login-form").hidden = true;
    return;
  }
  state.config = config;
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      setTimeout(showLogin, 0);
      return;
    }
    if (!session?.user) {
      if (event === "INITIAL_SESSION") setTimeout(showLogin, 0);
      return;
    }
    if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "USER_UPDATED") {
      setTimeout(() => enterApp(session.user), 0);
    }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js", { scope: "/DeploymentPlan/" }).catch(() => {});
  }
}

async function allowNotices() {
  try { localStorage.setItem("roster-notify", "asked"); } catch { /* private mode */ }
  if (typeof Notification === "undefined") {
    toast("This browser doesn’t show desktop notices. In-app notices still appear.");
    renderView();
    return;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    toast("You’ll get a notice when your shift changes, and a reminder if you have not signed on.");
    checkSignOnReminders();
  } else toast("In-app notices will still show when your shift changes.");
  renderView();
}

start();
