// A real peak is a run number such as 4, 4&5, or 6&7, or OCT.
// Words such as OFFICE, WFH, and FLEX are the place for the day, not the peak strip.

export function isPeakCode(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^[\d][\d,&\s]*$/.test(text) || text.toUpperCase() === "OCT";
}

function areaKey(area) {
  return String(area || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Plain PROCESSING is shown as MET PROCESSING. STAT PROCESSING and VMC PROCESSING stay as written. */
export function areaLabel(area) {
  const text = String(area || "").trim();
  if (areaKey(text) === "PROCESSING") return "MET PROCESSING";
  return text;
}

/** processing = light orange. met = light blue. Anything else keeps the published green. */
export function areaTone(area) {
  const key = areaKey(area);
  if (key === "PROCESSING" || key === "MET PROCESSING" || key === "STAT PROCESSING" || key === "VMC PROCESSING") return "processing";
  if (key === "MET" || /^MET\s+\d/.test(key) || /^MET\d/.test(key) || (key.startsWith("MET ") && key !== "MET PROCESSING")) return "met";
  return "";
}

export function peakAndArea(peakValue, areaValue) {
  let peak = String(peakValue || "").trim();
  let area = String(areaValue || "").trim();
  if (!area && peak && !isPeakCode(peak)) {
    area = peak;
    peak = "";
  }
  return { peak, area };
}
