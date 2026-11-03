// Radio status is one row per roster line (section, person, base or overtime, shift).
// Online, Office, Lunch, Offline, and Finished on one line do not change another.
// A second line the same day has its own key and its own status.

const SOLID_DAY_STATUSES = new Set(["online", "admin_oct", "lunch", "end"]);

// The line for one officer on one day: same section, same person, same base-or-overtime.
// A different shift on that day is still that line, so a multi-day save updates it.
export function officerDayTarget(rows, { day, officerCode, officerId, section, ot, preferId, excludeIds } = {}) {
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const code = String(officerCode || "").trim();
  const wantedOt = !!ot;
  const matches = (rows || []).filter((row) => {
    if (!row || skip.has(row.id)) return false;
    if (row.work_date !== day) return false;
    if (section && row.section !== section) return false;
    const rowOt = !!(row.is_ot || row.status === "ot");
    if (rowOt !== wantedOt) return false;
    if (code) return String(row.officer_code || "").trim() === code;
    if (officerId) return row.officer_id === officerId && !String(row.officer_code || "").trim();
    return false;
  });
  if (preferId) {
    const preferred = matches.find((row) => row.id === preferId);
    if (preferred) return preferred;
  }
  return matches[0] || null;
}

export function planLineKey({ section, who, ot, shift, duplicateId } = {}) {
  const base = `${section ?? ""}|${who ?? ""}|${ot ? "ot" : "base"}|${shift || ""}`;
  return duplicateId ? `${base}|${duplicateId}` : base;
}

// Same grouping the full plan uses, so a status saved on a row hits that row only.
export function groupPlanLines(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const who = row.officer_code || row.officer_id || row.id;
    const ot = !!(row.is_ot || row.status === "ot");
    let key = planLineKey({ section: row.section, who, ot, shift: row.shift });
    if (groups.get(key)?.byDay.has(row.work_date)) {
      key = planLineKey({ section: row.section, who, ot, shift: row.shift, duplicateId: row.id });
    }
    if (!groups.has(key)) groups.set(key, { section: row.section, sample: row, byDay: new Map(), lineKey: key });
    const group = groups.get(key);
    if (!group.byDay.has(row.work_date)) group.byDay.set(row.work_date, []);
    group.byDay.get(row.work_date).push(row);
  }
  return groups;
}

// Live roster search: every word must appear somewhere in the row's fields.
export function matchesRosterQuery(query, fields) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const blob = (fields || [])
    .filter((field) => field != null && String(field).trim() !== "")
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => blob.includes(token));
}

export function dayCellPaint({
  exempt = false,
  iso,
  today,
  status = "offline",
  keepColour = false,
} = {}) {
  const solidToday = !keepColour && iso === today && SOLID_DAY_STATUSES.has(status);
  return {
    unsigned: !keepColour && !exempt && !solidToday,
    ended: solidToday && status === "end",
  };
}
