// Offline Queensland parking / stopping lookup.
// Data: data/parking-offences.json (cached with the app shell).
(function (root) {
  const DATA_URL = "./data/parking-offences.json";
  const SEARCH_MS = 150;

  let pack = null;
  let loadPromise = null;
  let activeCategory = "";
  let query = "";
  let searchTimer = 0;
  let showingDetail = false;
  let bound = false;

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sectionRank(section) {
    const text = String(section ?? "");
    // Keep Brisbane commercial-loading guidance beside s 179, not at the bottom.
    if (/^bcc$/i.test(text)) return [178.5, ""];
    if (/^sch\b/i.test(text)) return [179.5, text.toLowerCase()];
    if (/^pt\b/i.test(text)) return [164.5, text.toLowerCase()];
    const match = text.match(/^(\d+)(.*)$/);
    if (!match) return [Number.MAX_SAFE_INTEGER, text.toLowerCase()];
    return [Number(match[1]), match[2].toLowerCase()];
  }

  function sectionLabel(section) {
    const text = String(section ?? "");
    if (/^(sch|bcc|pt)\b/i.test(text)) return text;
    return `s ${text}`;
  }

  function matchRank(offence, needle) {
    const title = String(offence.title || "").toLowerCase();
    const keywords = (Array.isArray(offence.keywords) ? offence.keywords : []).join("\n").toLowerCase();
    if (title.includes(needle)) return 0;
    if (keywords.includes(needle)) return 1;
    return 2;
  }

  function haystack(offence) {
    const tags = Array.isArray(offence.tags) ? offence.tags : [];
    const keywords = Array.isArray(offence.keywords) ? offence.keywords : [];
    const exceptions = Array.isArray(offence.exceptions) ? offence.exceptions : [];
    return [
      offence.title,
      offence.plainEnglish,
      offence.regCite,
      String(offence.section ?? ""),
      keywords.join(" "),
      tags.join(" "),
      exceptions.join(" ")
    ].join("\n").toLowerCase();
  }

  function filterOffences(offences, rawQuery, category) {
    const list = Array.isArray(offences) ? offences : [];
    const needle = String(rawQuery || "").trim().toLowerCase();
    const filtered = list.filter((offence) => {
      if (category && offence.category !== category) return false;
      if (!needle) return true;
      return haystack(offence).includes(needle);
    });
    filtered.sort((a, b) => {
      if (needle) {
        const ma = matchRank(a, needle);
        const mb = matchRank(b, needle);
        if (ma !== mb) return ma - mb;
      }
      const ra = sectionRank(a.section);
      const rb = sectionRank(b.section);
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[1] !== rb[1]) return ra[1] < rb[1] ? -1 : 1;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    return filtered;
  }

  function loadPack() {
    if (pack) return Promise.resolve(pack);
    if (!loadPromise) {
      loadPromise = fetch(DATA_URL, { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error("Could not load legislation.");
          return res.json();
        })
        .then((data) => {
          pack = data;
          return pack;
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setDisclaimer(text) {
    const host = el("legislationDisclaimer");
    if (!host) return;
    const full = String(text || "").trim();
    host.innerHTML = `<summary>Field guidance only — not legal advice.</summary><p>${esc(full)}</p>`;
  }

  function renderChips() {
    const host = el("legislationChips");
    if (!host || !pack) return;
    const categories = Array.isArray(pack.categories) ? pack.categories : [];
    const chips = [{ id: "", label: "All" }].concat(categories);
    host.innerHTML = chips.map((chip) => {
      const pressed = chip.id === activeCategory ? "true" : "false";
      return `<button type="button" class="sort-opt" data-legislation-category="${esc(chip.id)}" aria-pressed="${pressed}">${esc(chip.label)}</button>`;
    }).join("");
  }

  function renderResults() {
    const host = el("legislationResults");
    const detail = el("legislationDetail");
    if (!host) return;
    if (detail) detail.classList.add("hidden");
    host.classList.remove("hidden");
    showingDetail = false;
    if (!pack) {
      host.innerHTML = `<p class="muted">Loading…</p>`;
      return;
    }
    const offences = filterOffences(pack.offences, query, activeCategory);
    if (!offences.length) {
      host.innerHTML = `<p class="legislation-empty">No matches — try commercial loading, wrong way, yellow line, island, mail…</p>`;
      return;
    }
    const rows = offences.map((offence) => {
      return `<button type="button" class="legislation-row" data-offence-id="${esc(offence.id)}">
        <span class="legislation-row-head">
          <span class="legislation-row-title">${esc(offence.title)}</span>
          <span class="legislation-row-section">${esc(sectionLabel(offence.section))}</span>
        </span>
        <span class="legislation-row-plain">${esc(offence.plainEnglish)}</span>
      </button>`;
    }).join("");
    host.innerHTML = `<p class="muted legislation-count">${offences.length} ${offences.length === 1 ? "rule" : "rules"}</p>${rows}`;
  }

  function renderDetail(offence) {
    const host = el("legislationDetail");
    const results = el("legislationResults");
    if (!host || !offence) return;
    if (results) results.classList.add("hidden");
    host.classList.remove("hidden");
    showingDetail = true;
    const exceptions = Array.isArray(offence.exceptions) ? offence.exceptions : [];
    const bullets = exceptions.length
      ? `<ul class="legislation-exceptions">${exceptions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
      : "";
    const penalty = offence.penaltyNote
      ? `<p class="legislation-note">${esc(offence.penaltyNote)}</p>`
      : "";
    const disclaimer = pack && pack.disclaimer
      ? `<p class="legislation-card-disclaimer">${esc(pack.disclaimer)}</p>`
      : "";
    const sources = sourceList(offence);
    const sourceButtons = sources.map((source, index) => {
      const cls = index === 0 ? "primary legislation-official" : "secondary legislation-official";
      const label = source.label || sourceButtonLabel(source.url);
      return `<a class="${cls}" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    }).join("");
    const legislationSource = sources.some((source) => /legislation\.qld\.gov\.au/i.test(String(source.url || "")));
    const jump = legislationSource
      ? `<p class="legislation-jump-note">If a legislation link does not jump, search for ${esc(sectionLabel(offence.section))} in the official viewer.</p>`
      : "";
    host.innerHTML = `<button type="button" class="secondary legislation-back" id="legislationBack">Back to results</button>
      <h3 class="legislation-title">${esc(offence.title)}</h3>
      <p class="legislation-plain">${esc(offence.plainEnglish)}</p>
      ${bullets}
      <p class="legislation-cite">${esc(offence.regCite)}</p>
      ${penalty}
      ${disclaimer}
      ${sourceButtons}
      ${jump}`;
    const back = el("legislationBack");
    if (back) {
      back.onclick = () => {
        renderResults();
        const screen = el("legislation");
        if (screen) screen.scrollIntoView({ block: "start" });
      };
    }
    const screen = el("legislation");
    if (screen) screen.scrollIntoView({ block: "start" });
  }

  function sourceButtonLabel(url) {
    const text = String(url || "");
    if (/legislation\.qld\.gov\.au/i.test(text)) return "Open official legislation";
    if (/brisbane\.qld\.gov\.au/i.test(text)) return "Open Brisbane Council guidance";
    return "Open official source";
  }

  function sourceList(offence) {
    const extra = Array.isArray(offence.sources) ? offence.sources : [];
    const sources = extra.filter((source) => source && source.url);
    if (sources.length) return sources;
    if (offence.officialUrl) {
      return [{ label: sourceButtonLabel(offence.officialUrl), url: offence.officialUrl }];
    }
    return [];
  }

  function findOffence(id) {
    const offences = pack && Array.isArray(pack.offences) ? pack.offences : [];
    return offences.find((offence) => offence.id === id) || null;
  }

  function scheduleRender() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderResults, SEARCH_MS);
  }

  function bind() {
    if (bound) return;
    bound = true;
    const input = el("legislationSearch");
    if (input) {
      input.addEventListener("input", () => {
        query = input.value || "";
        if (showingDetail) renderResults();
        scheduleRender();
      });
    }
    const chips = el("legislationChips");
    if (chips) {
      chips.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-legislation-category]");
        if (!btn || !chips.contains(btn)) return;
        activeCategory = btn.getAttribute("data-legislation-category") || "";
        renderChips();
        renderResults();
      });
    }
    const results = el("legislationResults");
    if (results) {
      results.addEventListener("click", (event) => {
        const row = event.target.closest("[data-offence-id]");
        if (!row || !results.contains(row)) return;
        const offence = findOffence(row.getAttribute("data-offence-id"));
        if (offence) renderDetail(offence);
      });
    }
  }

  function open() {
    bind();
    const results = el("legislationResults");
    if (!pack && results) results.innerHTML = `<p class="muted">Loading…</p>`;
    loadPack()
      .then((data) => {
        setDisclaimer(data && data.disclaimer);
        renderChips();
        if (!showingDetail) renderResults();
      })
      .catch(() => {
        if (results) {
          results.innerHTML = `<p class="legislation-empty">Could not load TORUM Index. Open PinAssist online once, then try again.</p>`;
        }
      });
  }

  const api = { open, filterOffences, sectionRank, sectionLabel };
  root.PinLegislation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
