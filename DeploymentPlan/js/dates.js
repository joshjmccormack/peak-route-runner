const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week that contains `iso`. Weeks start Monday and end Sunday. */
export function mondayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  return addDays(iso, delta);
}

export function weekDates(mondayIso) {
  return Array.from({ length: 7 }, (_, i) => addDays(mondayIso, i));
}

export function sydneyToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    y,
    m,
    d,
    mon: MONTHS[m - 1],
    dow: dt.getUTCDay(),
  };
}

export function formatWeekRange(startIso, endIso) {
  const a = parts(startIso);
  const b = parts(endIso);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${a.mon} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${a.mon} – ${b.d} ${b.mon} ${a.y}`;
  return `${a.d} ${a.mon} ${a.y} – ${b.d} ${b.mon} ${b.y}`;
}

export function formatDayHeading(iso) {
  const p = parts(iso);
  return `${WEEKDAYS[p.dow]} ${p.d} ${p.mon}`;
}

export function formatDayShort(iso) {
  const p = parts(iso);
  return {
    dow: WEEKDAYS_SHORT[p.dow],
    date: `${p.d} ${p.mon}`,
  };
}
