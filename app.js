const DATA_FILES = {
  mcus: "data/mcu.csv",
  layouts: "data/pin_layout.csv",
  functions: "data/pin_functions.csv",
  properties: "data/pin_properties.csv",
  reserved: "data/reserved_pins.csv",
};

const COLORS = {
  ft: "#bbf7d0",
  ftf: "#4ade80",
  tt: "#fed7aa",
  tta: "#fde68a",
  reserved: "#ddd6fe",
  power: "#e2e8f0",
};

const state = {
  mcus: [],
  layouts: [],
  functions: [],
  properties: [],
  reserved: [],
  selectedFunctions: new Map(),
  dirty: false,
  currentMcu: "",
  currentFileName: "",
  activePin: "",
};

const els = {
  mcuSelect: document.querySelector("#mcuSelect"),
  searchInput: document.querySelector("#searchInput"),
  packageCanvas: document.querySelector("#packageCanvas"),
  pinInfo: document.querySelector("#pinInfo"),
  openCsvButton: document.querySelector("#openCsvButton"),
  saveCsvButton: document.querySelector("#saveCsvButton"),
  csvFileInput: document.querySelector("#csvFileInput"),
  toast: document.querySelector("#toast"),
};

init().catch((error) => {
  showToast(`Failed to load app data: ${error.message}`, true);
});

async function init() {
  const [mcus, layouts, functions, properties, reserved] = await Promise.all([
    loadCsv(DATA_FILES.mcus),
    loadCsv(DATA_FILES.layouts),
    loadCsv(DATA_FILES.functions),
    loadCsv(DATA_FILES.properties),
    loadCsv(DATA_FILES.reserved),
  ]);

  state.mcus = mcus;
  state.layouts = layouts;
  state.functions = functions;
  state.properties = properties;
  state.reserved = reserved;

  for (const mcu of mcus) {
    const option = document.createElement("option");
    option.value = mcu.mcu;
    option.textContent = mcu.mcu;
    els.mcuSelect.append(option);
  }

  els.mcuSelect.addEventListener("change", handleMcuChange);
  els.searchInput.addEventListener("input", render);
  els.openCsvButton.addEventListener("click", () => els.csvFileInput.click());
  els.csvFileInput.addEventListener("change", openCsv);
  els.saveCsvButton.addEventListener("click", saveCsv);
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  state.currentMcu = els.mcuSelect.value;
  render();
}

async function loadCsv(path) {
  const embedded = window.EMBEDDED_CSV?.[path];
  if (embedded !== undefined) return parseCsv(embedded);

  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return parseCsv(await response.text());
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, ""));
  return rows
    .filter((items) => items.some((item) => item.trim()))
    .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}

function render() {
  const mcu = currentMcu();
  if (!mcu) return;
  const pins = pinStates(mcu);
  renderPackage(mcu, pins);
  renderInfo(mcu, pins.find((pin) => pin.name === state.activePin));
}

function currentMcu() {
  return state.mcus.find((mcu) => mcu.mcu === els.mcuSelect.value);
}

function pinStates(mcu) {
  const packageLayouts = state.layouts
    .filter((layout) => layout.package === mcu.package)
    .sort((a, b) => sideOrder(a.side) - sideOrder(b.side) || Number(a.index) - Number(b.index));

  return packageLayouts.map((layout) => {
    const functions = state.functions.filter((item) => item.mcu === mcu.mcu && item.pin === layout.pin_name);
    const properties = state.properties.find((item) => item.mcu === mcu.mcu && item.pin === layout.pin_name);
    const reserved = state.reserved.filter((item) => item.mcu === mcu.mcu && item.pin === layout.pin_name);
    return {
      layout,
      name: layout.pin_name,
      functions,
      properties,
      reserved,
      selectedFunction: state.selectedFunctions.get(layout.pin_name) || "",
      roleLabel: roleLabel(functions, els.searchInput.value),
    };
  });
}

function sideOrder(side) {
  return { LEFT: 0, BOTTOM: 1, RIGHT: 2, TOP: 3 }[side] ?? 4;
}

function renderPackage(mcu, pins) {
  els.packageCanvas.replaceChildren();
  const layout = packageMetrics(pins);
  els.packageCanvas.style.width = `${layout.canvasW}px`;
  els.packageCanvas.style.height = `${layout.canvasH}px`;

  const chip = div("chip-body", mcu.mcu);
  chip.style.left = `${layout.body.left}px`;
  chip.style.top = `${layout.body.top}px`;
  chip.style.width = `${layout.body.w}px`;
  chip.style.height = `${layout.body.h}px`;
  els.packageCanvas.append(chip);

  const groups = Object.groupBy ? Object.groupBy(pins, (pin) => pin.layout.side.toUpperCase()) : groupBySide(pins);
  for (const [side, sidePins] of Object.entries(groups)) {
    sidePins.sort((a, b) => Number(a.layout.index) - Number(b.layout.index));
    sidePins.forEach((pin, position) => renderPin(pin, side, position, sidePins.length, layout));
  }
}

function packageMetrics(pins) {
  const pitch = 23;
  const pinW = 74;
  const pinH = 18;
  const gap = 16;
  const labelSpaces = requiredLabelSpaces(pins);
  const topSpace = pinW + gap + labelSpaces.TOP;
  const leftSpace = pinW + gap + labelSpaces.LEFT;
  const counts = { LEFT: 0, RIGHT: 0, TOP: 0, BOTTOM: 0 };
  for (const pin of pins) {
    const side = pin.layout.side.toUpperCase();
    counts[side] = (counts[side] || 0) + 1;
  }

  const maxPinsOnSide = Math.max(counts.TOP, counts.BOTTOM, counts.LEFT, counts.RIGHT, 1);
  const bodySize = Math.max(176, (maxPinsOnSide - 1) * pitch + pinH);
  const bodyW = bodySize;
  const bodyH = bodySize;
  const body = { left: leftSpace, top: topSpace, w: bodyW, h: bodyH };
  body.right = body.left + body.w;
  body.bottom = body.top + body.h;

  return {
    body,
    counts,
    pitch,
    pinW,
    pinH,
    gap,
    labelSpaces,
    canvasW: body.right + pinW + gap + labelSpaces.RIGHT,
    canvasH: body.bottom + pinW + gap + labelSpaces.BOTTOM,
  };
}

function requiredLabelSpaces(pins) {
  return Object.fromEntries(
    ["LEFT", "RIGHT", "TOP", "BOTTOM"].map((side) => {
      const labels = pins
        .filter((pin) => pin.layout.side.toUpperCase() === side)
        .flatMap((pin) => [pin.selectedFunction, pin.roleLabel])
        .filter(Boolean);
      return [side, requiredLabelSpace(labels)];
    }),
  );
}

function requiredLabelSpace(labels) {
  if (!labels.length) return 100;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = '700 11px Arial, "Yu Gothic", "Meiryo", sans-serif';
  const longest = Math.max(...labels.map((label) => context.measureText(label).width));
  return Math.max(100, Math.ceil(longest) + 50);
}

function groupBySide(pins) {
  return pins.reduce((acc, pin) => {
    const side = pin.layout.side.toUpperCase();
    acc[side] = acc[side] || [];
    acc[side].push(pin);
    return acc;
  }, {});
}

function renderPin(pin, side, position, count, layout) {
  const metrics = pinMetrics(side, position, count, layout);
  const item = div(`pin ${pin.name === state.activePin ? "active" : ""}`, pin.name);
  item.style.left = `${metrics.x}px`;
  item.style.top = `${metrics.y}px`;
  item.style.width = `${metrics.w}px`;
  item.style.height = `${metrics.h}px`;
  item.style.background = pinColor(pin);
  if (metrics.rotateText) item.classList.add("rotated-pin-text");
  item.title = tooltip(pin);
  item.addEventListener("click", () => {
    state.activePin = pin.name;
    render();
  });
  els.packageCanvas.append(item);

  const number = div("pin-number", pin.layout.pin_number);
  number.style.left = `${metrics.numberX}px`;
  number.style.top = `${metrics.numberY}px`;
  els.packageCanvas.append(number);

  const label = div("selected-function-label", pin.selectedFunction);
  label.title = pin.selectedFunction;
  if (metrics.rotateText) label.classList.add("rotated-label");
  label.style.left = `${metrics.labelX}px`;
  label.style.top = `${metrics.labelY}px`;
  if (metrics.labelW) label.style.width = `${metrics.labelW}px`;
  if (metrics.labelAlign) label.style.textAlign = metrics.labelAlign;
  els.packageCanvas.append(label);

  if (pin.roleLabel) {
    const role = div("role-label", pin.roleLabel);
    if (metrics.rotateRole) role.classList.add("rotated-label");
    role.style.left = `${metrics.roleX}px`;
    role.style.top = `${metrics.roleY}px`;
    if (metrics.roleW) role.style.width = `${metrics.roleW}px`;
    if (metrics.roleAlign) role.style.textAlign = metrics.roleAlign;
    els.packageCanvas.append(role);
  }
}

function pinMetrics(side, position, count, layout) {
  const chip = layout.body;
  const { pitch, pinW, pinH, gap } = layout;
  const labelSpace = layout.labelSpaces[side];
  const labelWidth = labelSpace - 16;
  const p = side === "RIGHT" ? count - 1 - position : position;
  const verticalColumnH = (count - 1) * pitch + pinH;
  const horizontalRowW = (count - 1) * pitch + pinH;
  const verticalOffset = Math.max(0, (chip.h - verticalColumnH) / 2);
  const horizontalOffset = Math.max(0, (chip.w - horizontalRowW) / 2);

  if (side === "LEFT") {
    const x = chip.left - gap - pinW;
    const y = chip.top + verticalOffset + p * pitch;
    return { x, y, w: pinW, h: pinH, labelX: x - labelWidth - 8, labelY: y + 3, labelW: labelWidth, labelAlign: "right", roleX: x - labelWidth - 8, roleY: y + 16, roleW: labelWidth, roleAlign: "right", numberX: x + pinW + 5, numberY: y + 4, rotateRole: false };
  }
  if (side === "RIGHT") {
    const x = chip.right + gap;
    const y = chip.top + verticalOffset + p * pitch;
    return { x, y, w: pinW, h: pinH, labelX: x + pinW + 8, labelY: y + 3, labelW: labelWidth, roleX: x + pinW + 8, roleY: y + 16, roleW: labelWidth, numberX: x - 18, numberY: y + 4, rotateRole: false };
  }
  if (side === "TOP") {
    const x = chip.left + horizontalOffset + p * pitch;
    const y = chip.top - gap - pinW;
    return { x, y, w: pinH, h: pinW, labelX: x + 4, labelY: y - 8, labelW: labelWidth, roleX: x + 17, roleY: y - 8, roleW: labelWidth, numberX: x + 3, numberY: y + pinW + 5, rotateText: true, rotateRole: true };
  }
  const x = chip.left + horizontalOffset + p * pitch;
  const y = chip.bottom + gap;
  return { x, y, w: pinH, h: pinW, labelX: x + 4, labelY: y + pinW + labelWidth + 8, labelW: labelWidth, labelAlign: "right", roleX: x + 17, roleY: y + pinW + labelWidth + 8, roleW: labelWidth, roleAlign: "right", numberX: x + 3, numberY: y - 17, rotateText: true, rotateRole: true };
}

function pinColor(pin) {
  if (pin.reserved.length) return COLORS.reserved;
  if (!pin.name.startsWith("P")) return COLORS.power;
  const props = pin.properties || {};
  if (truthy(props.FTf)) return COLORS.ftf;
  if (truthy(props.TTa)) return COLORS.tta;
  if (truthy(props.ft)) return COLORS.ft;
  return COLORS.tt;
}

function truthy(value) {
  return ["1", "true", "yes", "y"].includes(String(value || "").trim().toLowerCase());
}

function roleLabel(functions, query) {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return "";
  const exact = functions.find((item) => item.function.toUpperCase() === normalized || item.alias.toUpperCase() === normalized);
  if (exact) return exact.function;
  const partial = functions.find((item) => item.function.toUpperCase().includes(normalized));
  return partial ? partial.function : "";
}

function tooltip(pin) {
  const flags = [];
  const props = pin.properties || {};
  if (truthy(props.ft)) flags.push("FT");
  if (truthy(props.TTa)) flags.push("TTA");
  if (truthy(props.FTf)) flags.push("FTf");
  if (pin.reserved.length) flags.push(`Reserved: ${pin.reserved.map((item) => item.type).join(", ")}`);
  if (pin.selectedFunction) flags.push(`Selected: ${pin.selectedFunction}`);
  return flags.length ? `${pin.name} (${flags.join(", ")})` : pin.name;
}

function renderInfo(mcu, pin) {
  if (!pin) {
    els.pinInfo.innerHTML = `
      <div class="info-line">MCU: ${escapeHtml(mcu.mcu)}</div>
      <div class="info-line">Package: ${escapeHtml(mcu.package)} (${escapeHtml(mcu.pin_count)} pins)</div>
      <div class="info-line">Visible pins: ${pinStates(mcu).length}</div>
    `;
    return;
  }

  const selected = state.selectedFunctions.get(pin.name) || "none";
  els.pinInfo.innerHTML = `
    <strong>${escapeHtml(pin.name)}</strong>
    <div class="info-line">Pin number: ${escapeHtml(pin.layout.pin_number)}</div>
    <div class="info-line">Selected: ${escapeHtml(selected)}</div>
    <strong>Functions</strong>
    <div class="function-list"></div>
    <strong>Properties</strong>
    <div>${escapeHtml(propertyText(pin))}</div>
    ${pin.reserved.length ? `<div>Reserved: ${escapeHtml(pin.reserved.map((item) => item.type).join(", "))}</div>` : ""}
  `;

  const list = els.pinInfo.querySelector(".function-list");
  if (!pin.functions.length) {
    list.textContent = "none";
    return;
  }
  for (const fn of pin.functions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `function-button ${state.selectedFunctions.get(pin.name) === fn.function ? "selected" : ""}`;
    button.textContent = fn.function;
    button.addEventListener("click", () => toggleFunction(pin.name, fn.function));
    list.append(button);
  }
}

function propertyText(pin) {
  const props = pin.properties || {};
  const flags = [];
  if (truthy(props.ft)) flags.push("FT");
  if (truthy(props.TTa)) flags.push("TTA");
  if (truthy(props.FTf)) flags.push("FTf");
  if (truthy(props.boot)) flags.push("BOOT");
  return flags.length ? flags.join(", ") : "none";
}

function toggleFunction(pin, fn) {
  if (state.selectedFunctions.get(pin) === fn) {
    state.selectedFunctions.delete(pin);
  } else {
    state.selectedFunctions.set(pin, fn);
  }
  state.dirty = true;
  render();
}

function handleMcuChange() {
  if (state.dirty && !confirm("Pin settings have not been saved. Change MCU and discard them?")) {
    els.mcuSelect.value = state.currentMcu;
    return;
  }
  state.currentMcu = els.mcuSelect.value;
  state.selectedFunctions.clear();
  state.currentFileName = "";
  state.activePin = "";
  state.dirty = false;
  render();
}

async function openCsv() {
  const file = els.csvFileInput.files[0];
  els.csvFileInput.value = "";
  if (!file) return;
  if (state.dirty && !confirm("Pin settings have not been saved. Open CSV and discard them?")) {
    return;
  }
  try {
    const rows = parseCsv(await file.text());
    const { mcu, settings } = validateSettingsCsv(rows);
    els.mcuSelect.value = mcu;
    state.currentMcu = mcu;
    state.selectedFunctions = settings;
    state.currentFileName = file.name;
    state.activePin = "";
    state.dirty = false;
    render();
    showToast("CSV loaded.");
  } catch (error) {
    alert(error.message);
  }
}

function validateSettingsCsv(rows) {
  if (!rows.length) throw new Error("CSV contains no pin settings.");
  const headers = Object.keys(rows[0]);
  if (headers.join(",") !== "mcu,pin,function") {
    throw new Error("CSV format is invalid. Expected columns: mcu,pin,function");
  }
  const mcu = rows[0].mcu.trim();
  if (!state.mcus.some((item) => item.mcu === mcu)) throw new Error(`CSV targets an unknown MCU: ${mcu}`);
  const mcuData = state.mcus.find((item) => item.mcu === mcu);
  const validPins = new Set(state.layouts.filter((layout) => layout.package === mcuData.package).map((layout) => layout.pin_name));
  const settings = new Map();

  rows.forEach((row, index) => {
    const line = index + 2;
    const rowMcu = row.mcu.trim();
    const pin = row.pin.trim();
    const fn = row.function.trim();
    if (!rowMcu || !pin || !fn) throw new Error(`CSV row ${line} is invalid. mcu, pin, and function are required.`);
    if (rowMcu !== mcu) throw new Error(`CSV row ${line} targets MCU '${rowMcu}', but CSV target MCU is '${mcu}'.`);
    if (!validPins.has(pin)) throw new Error(`CSV row ${line} contains an unknown pin: ${pin}`);
    const allowed = state.functions.some((item) => item.mcu === mcu && item.pin === pin && item.function === fn);
    if (!allowed) throw new Error(`CSV row ${line} cannot set function '${fn}' on pin ${pin}.`);
    if (settings.has(pin)) throw new Error(`CSV row ${line} duplicates pin ${pin}.`);
    settings.set(pin, fn);
  });

  return { mcu, settings };
}

function saveCsv() {
  const mcu = els.mcuSelect.value;
  const lines = ["mcu,pin,function"];
  [...state.selectedFunctions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([pin, fn]) => lines.push([mcu, pin, fn].map(csvCell).join(",")));
  const blob = new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = state.currentFileName || `${mcu}_pin_settings.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  state.dirty = false;
  showToast("CSV downloaded.");
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function div(className, text = "") {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2200);
}
