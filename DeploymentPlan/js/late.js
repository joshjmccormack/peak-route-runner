// Sign-on is the officer's radio status becoming Online for that Sydney day.
// These helpers decide the 20-minute reminder and the 30-minute Late row
// from a shift start already on the roster. They do not read the clock
// unless the caller passes the current Sydney minute-of-day.

export const SIGN_ON_REMIND_MINUTES = 20;
export const SIGN_ON_LATE_MINUTES = 30;

const NOT_WORKING = new Set(["sick", "leave", "stood_down"]);

// ROC Coordinators are section ROC. Senior leadership is section SLG.
// An slg or roc login is exempt even when a line is filed under another band.
const EXEMPT_SECTIONS = new Set(["ROC", "SLG"]);
const EXEMPT_ROLES = new Set(["slg", "roc"]);

export function hasOfficerCode(code) {
  return String(code ?? "").trim() !== "";
}

function exemptSection(section) {
  return EXEMPT_SECTIONS.has(String(section || "").trim().toUpperCase());
}

function exemptRole(role) {
  return EXEMPT_ROLES.has(String(role || "").trim().toLowerCase());
}

/** Blank code, the ROC or senior-leadership section, or an slg/roc login. These people are not asked to sign on. */
export function exemptFromSignOn({ code, role, section } = {}) {
  if (!hasOfficerCode(code)) return true;
  if (exemptSection(section)) return true;
  if (exemptRole(role)) return true;
  return false;
}

export function shiftStartMinutes(shift) {
  const match = String(shift || "").match(/(\d{3,4})/);
  if (!match) return null;
  const digits = match[1].padStart(4, "0");
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2));
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function sydneyClockMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  const hour = pick("hour");
  const minute = pick("minute");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** Earliest working shift start among today's lines. Sick, leave, and STOOD DOWN do not count. */
export function workingStartMinutes(items, rowShift) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const working = list.filter((item) => !NOT_WORKING.has(item?.status || "draft"));
  if (!working.length) return null;
  let best = null;
  for (const item of working) {
    const start = shiftStartMinutes(item?.shift || rowShift);
    if (start == null) continue;
    if (best == null || start < best) best = start;
  }
  return best;
}

export function signOnState({ items, rowShift, online, nowMinutes, code, role }) {
  const list = Array.isArray(items) ? items : [];
  const carried = list.find((item) => item && Object.prototype.hasOwnProperty.call(item, "officer_code"));
  const resolved = code !== undefined ? code : carried?.officer_code;
  const codeKnown = code !== undefined || carried !== undefined;
  if (codeKnown && !hasOfficerCode(resolved)) {
    return { start: null, late: false, remind: false };
  }
  if (exemptRole(role)) {
    return { start: null, late: false, remind: false };
  }
  const accountable = list.filter((item) => !exemptSection(item?.section));
  const start = workingStartMinutes(accountable, accountable.length ? rowShift : null);
  if (start == null || online || nowMinutes == null) {
    return { start, late: false, remind: false };
  }
  const elapsed = nowMinutes - start;
  return {
    start,
    late: elapsed >= SIGN_ON_LATE_MINUTES,
    remind: elapsed >= SIGN_ON_REMIND_MINUTES,
  };
}

export function reminderKey(code, date, start) {
  return `${code}|${date}|${start}`;
}

// Online or Office signs the officer on. The unlock stays for the Sydney day,
// so LATE does not come back if they later choose Lunch, Offline, or Finished.
export function lateMarkerCleared({ status, unlocked } = {}) {
  return !!unlocked || status === "online" || status === "admin_oct";
}

// Plan rows: this line's own start, then officer name. Overtime does not
// borrow the start from the officer's other line.
export function comparePlanLines(a, b) {
  const startA = shiftStartMinutes(a?.shift) ?? 24 * 60;
  const startB = shiftStartMinutes(b?.shift) ?? 24 * 60;
  if (startA !== startB) return startA - startB;
  const name = String(a?.name || "").localeCompare(String(b?.name || ""), "en", { sensitivity: "base" });
  if (name) return name;
  const ot = Number(!!a?.ot) - Number(!!b?.ot);
  if (ot) return ot;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}
