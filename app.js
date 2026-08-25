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
  customLabelNames: new Map(),
  labelElectricalTypes: new Map(),
  dirty: false,
  currentMcu: "",
  currentFileName: "",
  activePin: "",
  templateInspection: null,
  inspectedTemplateText: "",
  outputStale: true,
};

const els = {
  mcuSelect: document.querySelector("#mcuSelect"),
  searchInput: document.querySelector("#searchInput"),
  packagePanel: document.querySelector(".package-panel"),
  packageStage: document.querySelector("#packageStage"),
  packageCanvas: document.querySelector("#packageCanvas"),
  pinInfo: document.querySelector("#pinInfo"),
  openCsvButton: document.querySelector("#openCsvButton"),
  saveCsvButton: document.querySelector("#saveCsvButton"),
  csvFileInput: document.querySelector("#csvFileInput"),
  labelTypeSelect: document.querySelector("#labelTypeSelect"),
  templateInput: document.querySelector("#templateInput"),
  pasteTemplateButton: document.querySelector("#pasteTemplateButton"),
  inspectTemplateButton: document.querySelector("#inspectTemplateButton"),
  templateStatus: document.querySelector("#templateStatus"),
  transformDetails: document.querySelector("#transformDetails"),
  labelSettings: document.querySelector("#labelSettings"),
  labelSettingsTab: document.querySelector("#labelSettingsTab"),
  manualInputDetails: document.querySelector("#manualInputDetails"),
  manualOutputDetails: document.querySelector("#manualOutputDetails"),
  transformButton: document.querySelector("#transformButton"),
  templateOutput: document.querySelector("#templateOutput"),
  transformSummary: document.querySelector("#transformSummary"),
  copyOutputButton: document.querySelector("#copyOutputButton"),
  toast: document.querySelector("#toast"),
};

init().catch((error) => {
  showToast(`アプリデータを読み込めませんでした: ${error.message}`);
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
  els.templateInput.addEventListener("input", handleTemplateInput);
  els.pasteTemplateButton.addEventListener("click", pasteTemplateFromClipboard);
  els.inspectTemplateButton.addEventListener("click", inspectTemplate);
  els.labelTypeSelect.addEventListener("change", () => {
    state.dirty = true;
    invalidateOutput("ラベル種類が変更されました。もう一度コピーしてください。");
  });
  const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
  tabButtons.forEach((button, index) => {
    button.addEventListener("click", () => selectTab(button.dataset.tabTarget));
    button.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabButtons.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabButtons.length - 1;
      else return;
      event.preventDefault();
      const nextButton = tabButtons[nextIndex];
      selectTab(nextButton.dataset.tabTarget);
      nextButton.focus();
    });
  });
  els.transformButton.addEventListener("click", () => transformTemplate());
  els.copyOutputButton.addEventListener("click", () => copyOutput(false));
  if ("ResizeObserver" in window) {
    new ResizeObserver(fitPackage).observe(els.packagePanel);
  } else {
    window.addEventListener("resize", fitPackage);
  }
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  state.currentMcu = els.mcuSelect.value;
  selectTab("details");
  render();
}

function selectTab(target) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    const selected = button.dataset.tabTarget === target;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const selected = panel.dataset.tabPanel === target;
    panel.classList.toggle("active", selected);
    panel.hidden = !selected;
  });
}

async function loadCsv(path) {
  const embedded = window.EMBEDDED_CSV?.[path];
  if (embedded !== undefined) return PinSettings.parseCsv(embedded);

  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return PinSettings.parseCsv(await response.text());
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
  renderLabelSettings(mcu);
}

function currentMcu() {
  return state.mcus.find((mcu) => mcu.mcu === els.mcuSelect.value);
}

function pinStates(mcu) {
  let resolvedLabels = {};
  try {
    resolvedLabels = KiCadTemplate.resolveLabelNames(state.selectedFunctions, state.customLabelNames);
  } catch (_error) {
    resolvedLabels = Object.fromEntries(state.selectedFunctions);
  }
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
      selectedLabel: resolvedLabels[layout.pin_name] || "",
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
  els.packageCanvas.dataset.width = String(layout.canvasW);
  els.packageCanvas.dataset.height = String(layout.canvasH);
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
  requestAnimationFrame(fitPackage);
}

function fitPackage() {
  const canvasWidth = Number(els.packageCanvas.dataset.width || 0);
  const canvasHeight = Number(els.packageCanvas.dataset.height || 0);
  const availableWidth = Math.max(0, els.packagePanel.clientWidth - 16);
  const availableHeight = Math.max(0, els.packagePanel.clientHeight - 16);
  if (!canvasWidth || !canvasHeight || !availableWidth || !availableHeight) return;
  const scale = Math.min(1, availableWidth / canvasWidth, availableHeight / canvasHeight);
  els.packageStage.style.width = `${Math.floor(canvasWidth * scale)}px`;
  els.packageStage.style.height = `${Math.floor(canvasHeight * scale)}px`;
  els.packageCanvas.style.transform = `scale(${scale})`;
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
  const item = document.createElement("button");
  item.type = "button";
  item.className = `pin ${pin.name === state.activePin ? "active" : ""} ${pin.roleLabel ? "search-match" : ""}`;
  item.textContent = pin.name;
  item.style.left = `${metrics.x}px`;
  item.style.top = `${metrics.y}px`;
  item.style.width = `${metrics.w}px`;
  item.style.height = `${metrics.h}px`;
  item.style.background = pinColor(pin);
  if (metrics.rotateText) item.classList.add("rotated-pin-text");
  item.title = tooltip(pin);
  item.dataset.pinName = pin.name;
  item.setAttribute("aria-pressed", String(pin.name === state.activePin));
  item.setAttribute(
    "aria-label",
    `${pin.name}、物理ピン${pin.layout.pin_number}${pin.selectedFunction ? `、機能${pin.selectedFunction}、ラベル${pin.selectedLabel}` : "、未設定"}`,
  );
  item.addEventListener("click", () => {
    state.activePin = pin.name;
    render();
    requestAnimationFrame(() => {
      [...els.packageCanvas.querySelectorAll(".pin")]
        .find((button) => button.dataset.pinName === pin.name)
        ?.focus();
    });
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
  if (pin.selectedLabel) flags.push(`Label: ${pin.selectedLabel}`);
  return flags.length ? `${pin.name} (${flags.join(", ")})` : pin.name;
}

function renderInfo(mcu, pin) {
  if (!pin) {
    els.pinInfo.innerHTML = `
      <div class="info-line">MCU: ${escapeHtml(mcu.mcu)}</div>
      <div class="info-line">パッケージ: ${escapeHtml(mcu.package)}（${escapeHtml(mcu.pin_count)}ピン）</div>
      <div class="info-line">パッケージ図のピンを選択してください。</div>
    `;
    return;
  }

  const selected = state.selectedFunctions.get(pin.name) || "未設定";
  els.pinInfo.innerHTML = `
    <strong>${escapeHtml(pin.name)}</strong>
    <div class="info-line">物理ピン番号: ${escapeHtml(pin.layout.pin_number)}</div>
    <div class="info-line">選択中: ${escapeHtml(selected)}</div>
    <strong>機能一覧</strong>
    <div class="function-list"></div>
    <strong>特性</strong>
    <div>${escapeHtml(propertyText(pin))}</div>
    ${pin.reserved.length ? `<div>予約ピン: ${escapeHtml(pin.reserved.map((item) => item.type).join(", "))}</div>` : ""}
  `;

  const list = els.pinInfo.querySelector(".function-list");
  if (!pin.functions.length) {
    list.textContent = "選択できる機能はありません。";
    return;
  }
  for (const fn of pin.functions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `function-button ${state.selectedFunctions.get(pin.name) === fn.function ? "selected" : ""}`;
    button.textContent = fn.function;
    button.dataset.functionName = fn.function;
    button.setAttribute("aria-pressed", String(state.selectedFunctions.get(pin.name) === fn.function));
    button.addEventListener("click", () => {
      toggleFunction(pin.name, fn.function);
      requestAnimationFrame(() => {
        [...els.pinInfo.querySelectorAll(".function-button")]
          .find((item) => item.dataset.functionName === fn.function)
          ?.focus();
      });
    });
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
  return flags.length ? flags.join(", ") : "なし";
}

function toggleFunction(pin, fn) {
  if (state.selectedFunctions.get(pin) === fn) {
    state.selectedFunctions.delete(pin);
    state.customLabelNames.delete(pin);
    state.labelElectricalTypes.delete(pin);
  } else {
    state.selectedFunctions.set(pin, fn);
    state.customLabelNames.delete(pin);
    state.labelElectricalTypes.set(pin, defaultElectricalType(pin, fn));
  }
  state.dirty = true;
  invalidateOutput("ピン設定が変更されました。もう一度コピーしてください。");
  render();
}

function handleMcuChange() {
  if (state.dirty && !confirm("現在のピン設定を破棄してMCUを変更しますか？")) {
    els.mcuSelect.value = state.currentMcu;
    return;
  }
  state.currentMcu = els.mcuSelect.value;
  clearPinSettings();
  state.currentFileName = "";
  state.activePin = "";
  state.dirty = false;
  state.templateInspection = null;
  state.inspectedTemplateText = "";
  setTemplateStatus("MCUを変更しました。貼り付け済みの回路がある場合は、もう一度「回路を読み込む」を押してください。");
  invalidateOutput("MCUが変更されました。回路を再読み込みしてください。", true);
  render();
}

async function openCsv() {
  const file = els.csvFileInput.files[0];
  els.csvFileInput.value = "";
  if (!file) return;
  if (state.dirty && !confirm("現在のピン設定を破棄してCSVを読み込みますか？")) {
    return;
  }
  try {
    const rows = PinSettings.parseCsv(await file.text());
    const { mcu, settings, labelNames, electricalTypes } = PinSettings.validateSettingsCsv(rows, state);
    els.mcuSelect.value = mcu;
    state.currentMcu = mcu;
    state.selectedFunctions = settings;
    state.customLabelNames = labelNames;
    state.labelElectricalTypes = electricalTypes;
    state.currentFileName = file.name;
    state.activePin = "";
    state.dirty = false;
    state.templateInspection = null;
    state.inspectedTemplateText = "";
    if (els.templateInput.value.trim()) setTemplateStatus("CSVを読み込みました。回路をもう一度読み込んでMCUを確認してください。");
    invalidateOutput("CSVを読み込みました。回路を確認してからラベルを適用してください。", true);
    render();
    showToast("CSVを読み込みました。");
  } catch (error) {
    showError(error.message);
  }
}

function saveCsv() {
  const mcu = els.mcuSelect.value;
  const csv = PinSettings.serializeSettingsCsv({
    mcu,
    settings: state.selectedFunctions,
    labelNames: state.customLabelNames,
    electricalTypes: state.labelElectricalTypes,
    functions: state.functions,
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = state.currentFileName || `${mcu}_pin_settings.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  state.dirty = false;
  showToast("CSVをダウンロードしました。");
}

function defaultElectricalType(pin, functionName) {
  return PinSettings.defaultElectricalType(
    state.functions,
    els.mcuSelect.value,
    pin,
    functionName,
  );
}

function clearPinSettings() {
  state.selectedFunctions.clear();
  state.customLabelNames.clear();
  state.labelElectricalTypes.clear();
}

function renderLabelSettings(mcu) {
  els.labelSettings.replaceChildren();
  const selectedPins = [...state.selectedFunctions.keys()].sort((first, second) => {
    const firstLayout = state.layouts.find((layout) => layout.package === mcu.package && layout.pin_name === first);
    const secondLayout = state.layouts.find((layout) => layout.package === mcu.package && layout.pin_name === second);
    return Number(firstLayout?.pin_number || 0) - Number(secondLayout?.pin_number || 0) || first.localeCompare(second);
  });
  els.labelSettingsTab.textContent = selectedPins.length ? `ラベル設定 (${selectedPins.length})` : "ラベル設定";
  if (!selectedPins.length) {
    const empty = div("empty-settings", "機能を選択したピンがここに表示されます。");
    els.labelSettings.append(empty);
    return;
  }

  const errorBox = div("label-error");
  errorBox.hidden = true;
  els.labelSettings.append(errorBox);

  const scroll = div("label-table-scroll");
  const table = document.createElement("table");
  table.className = "label-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">ピン / 番号</th>
        <th scope="col">機能名</th>
        <th scope="col">ラベル名</th>
        <th scope="col">電気タイプ</th>
      </tr>
    </thead>
  `;
  const body = document.createElement("tbody");

  for (const pin of selectedPins) {
    const layout = state.layouts.find((item) => item.package === mcu.package && item.pin_name === pin);
    const row = document.createElement("tr");
    row.dataset.pin = pin;

    const pinCell = document.createElement("td");
    pinCell.className = "pin-cell";
    const strong = document.createElement("strong");
    strong.textContent = pin;
    const number = document.createElement("small");
    number.textContent = `#${layout?.pin_number || "-"}`;
    pinCell.append(strong, number);
    row.append(pinCell);

    const functionCell = document.createElement("td");
    const functionSelect = document.createElement("select");
    functionSelect.setAttribute("aria-label", `${pin}の機能`);
    functionSelect.dataset.settingPin = pin;
    state.functions
      .filter((item) => item.mcu === mcu.mcu && item.pin === pin)
      .forEach((item) => {
        const option = document.createElement("option");
        option.value = item.function;
        option.textContent = item.function;
        option.selected = state.selectedFunctions.get(pin) === item.function;
        functionSelect.append(option);
      });
    functionSelect.addEventListener("change", () => {
      state.selectedFunctions.set(pin, functionSelect.value);
      state.labelElectricalTypes.set(pin, defaultElectricalType(pin, functionSelect.value));
      state.dirty = true;
      invalidateOutput("ピン機能が変更されました。もう一度コピーしてください。");
      render();
      requestAnimationFrame(() => {
        [...els.labelSettings.querySelectorAll("select[data-setting-pin]")]
          .find((item) => item.dataset.settingPin === pin)
          ?.focus();
      });
    });
    functionCell.append(functionSelect);
    row.append(functionCell);

    const labelCell = document.createElement("td");
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = state.customLabelNames.get(pin) || "";
    labelInput.placeholder = state.selectedFunctions.get(pin);
    labelInput.dataset.labelPin = pin;
    labelInput.setAttribute("aria-label", `${pin}のラベル名`);
    labelInput.addEventListener("input", () => {
      const value = labelInput.value.trim();
      if (value) state.customLabelNames.set(pin, value);
      else state.customLabelNames.delete(pin);
      state.dirty = true;
      invalidateOutput("ラベル名が変更されました。もう一度コピーしてください。");
      refreshResolvedLabelHints();
    });
    labelCell.append(labelInput);
    row.append(labelCell);

    const typeCell = document.createElement("td");
    const typeSelect = document.createElement("select");
    typeSelect.setAttribute("aria-label", `${pin}の電気タイプ`);
    const typeOptions = [
      ["入力", "input"],
      ["出力", "output"],
      ["双方向", "bidirectional"],
      ["トライステート", "tri_state"],
      ["パッシブ", "passive"],
    ];
    const selectedType = state.labelElectricalTypes.get(pin) || defaultElectricalType(pin, state.selectedFunctions.get(pin));
    for (const [label, value] of typeOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === selectedType;
      typeSelect.append(option);
    }
    typeSelect.addEventListener("change", () => {
      state.labelElectricalTypes.set(pin, typeSelect.value);
      state.dirty = true;
      invalidateOutput("電気タイプが変更されました。もう一度コピーしてください。");
    });
    typeCell.append(typeSelect);
    row.append(typeCell);
    body.append(row);
  }
  table.append(body);
  scroll.append(table);
  els.labelSettings.append(scroll);
  refreshResolvedLabelHints();
}

function refreshResolvedLabelHints() {
  const errorBox = els.labelSettings.querySelector(".label-error");
  try {
    const resolved = KiCadTemplate.resolveLabelNames(state.selectedFunctions, state.customLabelNames);
    els.labelSettings.querySelectorAll("[data-label-pin]").forEach((input) => {
      const label = resolved[input.dataset.labelPin] || "";
      input.placeholder = label;
      input.title = `適用するラベル: ${label}`;
    });
    if (errorBox) errorBox.hidden = true;
  } catch (error) {
    if (!errorBox) return;
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

function handleTemplateInput() {
  state.templateInspection = null;
  state.inspectedTemplateText = "";
  setTemplateStatus("内容が変更されました。「回路を読み込む」を押して確認してください。");
  invalidateOutput("貼り付けた回路が変更されました。回路を再読み込みしてください。", true);
}

async function pasteTemplateFromClipboard() {
  try {
    if (!navigator.clipboard?.readText) throw new Error("このブラウザではクリップボードの自動読み取りを使用できません。");
    const text = await navigator.clipboard.readText();
    if (!text.trim()) throw new Error("クリップボードにテキストがありません。");
    els.templateInput.value = text;
    handleTemplateInput();
    inspectTemplate();
  } catch (error) {
    selectTab("kicad");
    els.manualInputDetails.open = true;
    els.templateInput.focus();
    setTemplateStatus(`${error.message} この欄を選択した状態でCtrl+Vしてください。`, "error");
  }
}

function inspectTemplate() {
  try {
    const text = els.templateInput.value;
    const detected = KiCadTemplate.inspectKiCadCircuitTemplate(text);
    const supported = state.mcus.some((item) => item.mcu === detected.mcuName);
    if (!supported) throw new Error(`回路から「${detected.mcuName}」を検出しましたが、現在のピンデータには登録されていません。`);
    if (detected.mcuName !== els.mcuSelect.value) {
      if (state.dirty && !confirm(`回路から${detected.mcuName}を検出しました。現在のピン設定を破棄してMCUを切り替えますか？`)) return false;
      els.mcuSelect.value = detected.mcuName;
      state.currentMcu = detected.mcuName;
      clearPinSettings();
      state.currentFileName = "";
      state.activePin = "";
      state.dirty = false;
      render();
    }
    const inspection = KiCadTemplate.inspectKiCadCircuitTemplate(text, els.mcuSelect.value);
    state.templateInspection = inspection;
    state.inspectedTemplateText = text;
    els.manualInputDetails.open = false;
    setTemplateStatus(
      `${inspection.mcuName}（${inspection.reference}）を読み込みました。部品${inspection.symbolCount}個、既存ラベル${inspection.labelCount}個。`,
      "success",
    );
    invalidateOutput("回路を読み込みました。ピン機能を設定してコピーしてください。", true);
    return true;
  } catch (error) {
    state.templateInspection = null;
    state.inspectedTemplateText = "";
    selectTab("kicad");
    els.manualInputDetails.open = true;
    setTemplateStatus(error.message, "error");
    invalidateOutput("回路を読み込めませんでした。貼り付け内容を確認してください。", true);
    return false;
  }
}

async function transformTemplate() {
  try {
    if (!state.templateInspection || state.inspectedTemplateText !== els.templateInput.value) {
      if (!inspectTemplate()) return;
    }
    const result = KiCadTemplate.buildKiCadCircuitTemplateClipboard({
      clipboardText: els.templateInput.value,
      mcuName: els.mcuSelect.value,
      settings: state.selectedFunctions,
      labelNames: state.customLabelNames,
      electricalTypes: state.labelElectricalTypes,
      labelType: els.labelTypeSelect.value,
    });
    els.templateOutput.value = result.text;
    state.outputStale = false;
    els.copyOutputButton.disabled = false;
    renderTransformResult(result);
    await copyOutput(true);
  } catch (error) {
    invalidateOutput(error.message, true, "error");
  }
}

function renderTransformResult(result) {
  els.transformSummary.textContent = `変換完了: ${result.count}件を変更、${result.existing}件は変更不要。`;
  els.transformSummary.className = result.conflicts.length || result.missingPins.length
    ? "apply-status warning-summary"
    : "apply-status success-summary";
  els.transformDetails.replaceChildren();
  const messages = [];
  if (result.missingPins.length) messages.push(`回路内に見つからないピン: ${result.missingPins.join(", ")}`);
  messages.push(...result.conflicts);
  if (messages.length) {
    const list = document.createElement("ul");
    messages.forEach((message) => {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    });
    els.transformDetails.append(list);
  }
}

async function copyOutput(automatic = false) {
  if (state.outputStale || !els.templateOutput.value) return false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("このブラウザではクリップボードへ自動コピーできません。");
    await navigator.clipboard.writeText(els.templateOutput.value);
    els.manualOutputDetails.open = false;
    if (!automatic) {
      els.transformSummary.className = "apply-status success-summary";
      els.transformSummary.textContent = "変換結果をコピーしました。";
      setTemplateStatus("変換結果をコピーしました。KiCadでCtrl+Vしてください。", "success");
    }
    showToast("変換結果をコピーしました。KiCadでCtrl+Vしてください。");
    return true;
  } catch (error) {
    selectTab("kicad");
    els.manualOutputDetails.open = true;
    els.templateOutput.focus();
    els.templateOutput.select();
    els.templateOutput.setSelectionRange(0, els.templateOutput.value.length);
    els.transformSummary.className = "apply-status warning-summary";
    els.transformSummary.textContent = `${automatic ? "変換は完了しました。" : ""} 自動コピーできませんでした。`;
    setTemplateStatus(`${error.message} 結果欄を選択したので、Ctrl+Cでコピーしてください。`, "error");
    return false;
  }
}

function setTemplateStatus(message, type = "neutral") {
  els.templateStatus.textContent = message;
  els.templateStatus.className = `status-card ${type === "neutral" ? "" : `${type}-status`}`.trim();
}

function invalidateOutput(message, clearText = false, type = "stale") {
  state.outputStale = true;
  els.copyOutputButton.disabled = true;
  if (clearText) els.templateOutput.value = "";
  els.transformDetails.replaceChildren();
  els.transformSummary.className = `apply-status ${type === "error" ? "error-summary" : "stale-summary"}`;
  els.transformSummary.textContent = message;
}

function showError(message) {
  invalidateOutput(message, false, "error");
  showToast("入力内容を確認してください。");
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
