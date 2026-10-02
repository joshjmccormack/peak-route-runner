window.PEAK_VEHICLES = {
  TACT: ["CP10", "CP20", "CP53", "CP57"],
  MET: ["CP69", "CP03", "CP21", "CP09"]
};

// charge_percent is an integer 0–100. New logs store the midpoint of the band
// (5, 15, … 95) so older exact percentages still map into the same bands.
window.PEAK_CHARGE_BANDS = [
  { id: "1-10", label: "1%–10%", store: 5, min: 1, max: 10, tone: "red" },
  { id: "11-20", label: "11%–20%", store: 15, min: 11, max: 20, tone: "red" },
  { id: "21-30", label: "21%–30%", store: 25, min: 21, max: 30, tone: "orange" },
  { id: "31-40", label: "31%–40%", store: 35, min: 31, max: 40, tone: "orange" },
  { id: "41-50", label: "41%–50%", store: 45, min: 41, max: 50, tone: "orange" },
  { id: "51-60", label: "51%–60%", store: 55, min: 51, max: 60, tone: "orange" },
  { id: "61-70", label: "61%–70%", store: 65, min: 61, max: 70, tone: "orange" },
  { id: "71-80", label: "71%–80%", store: 75, min: 71, max: 80, tone: "green" },
  { id: "81-90", label: "81%–90%", store: 85, min: 81, max: 90, tone: "green" },
  { id: "91-100", label: "91%–100%", store: 95, min: 91, max: 100, tone: "green" }
];
