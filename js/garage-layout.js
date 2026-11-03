// O'Connell Tce, Level 1 Podium — "41 OC - Car Park Allocation".
// Shared by the vehicle-charge bay picker. A later live view can reuse
// PEAK_GARAGE_LAYOUT: col/row keep the sign's relative positions, and
// ours/selectable mark bays Parking Compliance can log.
//
// Selectable (ours): 101–112 and 115–126. Those are the yellow bays.
// Shown but not ours: 113, 114, 127–132, the unnumbered pink bay,
// and both disabled (PWD) bays. The red cell between the PWD bays is
// not a bay.

(function () {
  var NOT_OURS = {
    "113": true,
    "114": true,
    "127": true,
    "128": true,
    "129": true,
    "130": true,
    "131": true,
    "132": true
  };

  function bay(number, col, row, region, extra) {
    var id = String(number);
    var ours = !NOT_OURS[id];
    var cell = {
      id: "bay-" + id,
      kind: "bay",
      number: id,
      col: col,
      row: row,
      region: region,
      ours: ours,
      selectable: ours,
      tone: ours ? "compliance" : "other",
      mark: ""
    };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        cell[key] = extra[key];
      });
    }
    if (!cell.ours) cell.selectable = false;
    return cell;
  }

  function marked(number, col, row, region) {
    return bay(number, col, row, region, { mark: "M" });
  }

  var layout = {
    id: "oct-level-1",
    title: "41 OC - Car Park Allocation",
    level: "Level 1 Podium",
    site: "O'Connell Tce",
    location: "OCT",
    columns: 15,
    rows: 8,
    cells: [
      marked(102, 1, 1, "left"),
      marked(101, 2, 1, "left"),
      bay(104, 1, 2, "left"),
      bay(103, 2, 2, "left"),
      bay(106, 1, 4, "left"),
      bay(105, 2, 4, "left"),
      bay(108, 1, 5, "left"),
      bay(107, 2, 5, "left"),
      bay(110, 1, 6, "left"),
      bay(109, 2, 6, "left"),
      bay(112, 1, 7, "left"),
      bay(111, 2, 7, "left"),

      {
        id: "pwd-west",
        kind: "pwd",
        number: null,
        label: "PWD",
        accessibleLabel: "Disabled parking",
        col: 4,
        row: 3,
        region: "centre",
        ours: false,
        selectable: false,
        tone: "pwd",
        mark: ""
      },
      {
        id: "centre-strip",
        kind: "strip",
        number: null,
        label: "",
        col: 5,
        row: 3,
        region: "centre",
        ours: false,
        selectable: false,
        tone: "red",
        mark: ""
      },
      {
        id: "pwd-east",
        kind: "pwd",
        number: null,
        label: "PWD",
        accessibleLabel: "Disabled parking",
        col: 6,
        row: 3,
        region: "centre",
        ours: false,
        selectable: false,
        tone: "pwd",
        mark: ""
      },
      bay(113, 7, 3, "centre", { tone: "compliance" }),
      bay(114, 8, 3, "centre", { tone: "compliance" }),
      bay(115, 9, 3, "centre"),
      bay(116, 10, 3, "centre"),
      bay(117, 11, 3, "centre"),
      bay(118, 12, 3, "centre"),

      marked(119, 14, 1, "right"),
      marked(120, 15, 1, "right"),
      bay(121, 14, 2, "right"),
      bay(122, 15, 2, "right"),
      bay(123, 14, 4, "right"),
      bay(124, 15, 4, "right"),
      bay(125, 14, 5, "right"),
      bay(126, 15, 5, "right"),

      bay(127, 9, 8, "bottom", { tone: "green" }),
      bay(128, 10, 8, "bottom", { tone: "green" }),
      bay(129, 11, 8, "bottom", { tone: "green" }),
      bay(130, 12, 8, "bottom", { tone: "green" }),
      bay(131, 13, 8, "bottom", { tone: "purple" }),
      bay(132, 14, 8, "bottom", { tone: "purple" }),
      {
        id: "bay-pink",
        kind: "bay",
        number: null,
        label: "",
        col: 15,
        row: 8,
        region: "bottom",
        ours: false,
        selectable: false,
        tone: "pink",
        mark: ""
      }
    ]
  };

  function cellsOf(source) {
    var layoutSource = source || window.PEAK_GARAGE_LAYOUT;
    return layoutSource && Array.isArray(layoutSource.cells) ? layoutSource.cells : [];
  }

  function peakGarageSelectableNumbers(source) {
    return cellsOf(source).filter(function (cell) {
      return cell.selectable === true && cell.number;
    }).map(function (cell) {
      return String(cell.number);
    });
  }

  function appendText(parent, className, text) {
    var span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
    return span;
  }

  function peakRenderGarageMap(host, options) {
    if (!host) return;
    var opts = options || {};
    var source = opts.layout || window.PEAK_GARAGE_LAYOUT;
    var selected = opts.selected ? String(opts.selected) : "";
    var onSelect = opts.onSelect;
    host.replaceChildren();
    if (!source) return;

    var grid = document.createElement("div");
    grid.className = "garage-grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", source.title || "Parking bays");

    cellsOf(source).forEach(function (cell) {
      var selectable = cell.selectable === true && !!cell.number;
      var el = document.createElement(selectable ? "button" : "div");
      el.className = "garage-cell gc-" + cell.col + " gr-" + cell.row
        + " kind-" + (cell.kind || "bay")
        + " tone-" + (cell.tone || "other");
      if (!cell.ours) el.classList.add("is-other");
      if (!selectable) el.classList.add("is-disabled");
      el.dataset.kind = cell.kind || "";
      el.dataset.ours = cell.ours ? "true" : "false";
      el.dataset.selectable = selectable ? "true" : "false";
      if (cell.region) el.dataset.region = cell.region;
      if (cell.number) el.dataset.bay = String(cell.number);

      if (selectable) {
        var pressed = selected === String(cell.number);
        el.type = "button";
        el.classList.add("garage-bay");
        el.setAttribute("aria-pressed", pressed ? "true" : "false");
        if (pressed) el.classList.add("is-selected");
        var name = "Bay " + cell.number;
        if (cell.mark) name += ", marked " + cell.mark;
        el.setAttribute("aria-label", pressed ? name + ", selected" : name);
        if (cell.mark) appendText(el, "garage-mark", cell.mark);
        appendText(el, "garage-num", String(cell.number));
        el.addEventListener("click", function () {
          if (typeof onSelect === "function") onSelect(String(cell.number));
        });
      } else if (cell.kind === "pwd") {
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", (cell.accessibleLabel || "Disabled parking") + ", not available");
        appendText(el, "garage-pwd-symbol", "\u267F").setAttribute("aria-hidden", "true");
        appendText(el, "garage-pwd-text", cell.label || "PWD").setAttribute("aria-hidden", "true");
      } else if (cell.kind === "strip") {
        el.setAttribute("role", "presentation");
        el.setAttribute("aria-hidden", "true");
      } else {
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", cell.number
          ? "Bay " + cell.number + ", not ours"
          : "Unnumbered bay, not ours");
        if (cell.number) appendText(el, "garage-num", String(cell.number));
      }
      grid.appendChild(el);
    });

    host.appendChild(grid);
  }

  window.PEAK_GARAGE_LAYOUTS = {};
  window.PEAK_GARAGE_LAYOUTS[layout.id] = layout;
  window.PEAK_GARAGE_LAYOUT = layout;
  window.peakGarageSelectableNumbers = peakGarageSelectableNumbers;
  window.peakRenderGarageMap = peakRenderGarageMap;
})();
