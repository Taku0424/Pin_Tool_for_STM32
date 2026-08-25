(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PinSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ELECTRICAL_TYPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"]);
  const SETTINGS_HEADERS = [
    ["mcu", "pin", "function"],
    ["mcu", "pin", "function", "label"],
    ["mcu", "pin", "function", "label", "electrical_type"],
  ];

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text || "");

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (quoted) {
        if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") field += char;
    }
    if (quoted) throw new Error("CSVの引用符が閉じられていません。");
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    if (!rows.length) return [];

    const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").trim());
    return rows
      .filter((items) => items.some((item) => item.trim()))
      .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
  }

  function defaultElectricalType(functionRows, mcu, pin, functionName) {
    const row = functionRows.find((item) => item.mcu === mcu && item.pin === pin && item.function === functionName);
    const value = String((row && row.electrical_type) || "bidirectional").trim().toLowerCase();
    return ELECTRICAL_TYPES.has(value) ? value : "bidirectional";
  }

  function validateSettingsCsv(rows, data) {
    if (!rows.length) throw new Error("CSVにピン設定がありません。");
    const headers = Object.keys(rows[0]);
    const validHeader = SETTINGS_HEADERS.some((expected) => expected.join(",") === headers.join(","));
    if (!validHeader) {
      throw new Error("CSV形式が正しくありません。mcu,pin,function または label・electrical_typeを追加した形式を使用してください。");
    }

    const mcu = String(rows[0].mcu || "").trim();
    const mcuData = data.mcus.find((item) => item.mcu === mcu);
    if (!mcuData) throw new Error(`CSVのMCU「${mcu || "(空欄)"}」は登録されていません。`);
    const validPins = new Set(data.layouts.filter((layout) => layout.package === mcuData.package).map((layout) => layout.pin_name));
    const settings = new Map();
    const labelNames = new Map();
    const electricalTypes = new Map();

    rows.forEach((row, index) => {
      const line = index + 2;
      const rowMcu = String(row.mcu || "").trim();
      const pin = String(row.pin || "").trim();
      const functionName = String(row.function || "").trim();
      const label = String(row.label || "").trim();
      if (!rowMcu || !pin || !functionName) throw new Error(`CSV ${line}行目: mcu、pin、functionは必須です。`);
      if (rowMcu !== mcu) throw new Error(`CSV ${line}行目: MCU「${rowMcu}」が先頭行の「${mcu}」と一致しません。`);
      if (!validPins.has(pin)) throw new Error(`CSV ${line}行目: ピン「${pin}」は${mcu}にありません。`);
      const allowed = data.functions.some((item) => item.mcu === mcu && item.pin === pin && item.function === functionName);
      if (!allowed) throw new Error(`CSV ${line}行目: ${pin}に機能「${functionName}」は設定できません。`);
      if (settings.has(pin)) throw new Error(`CSV ${line}行目: ピン「${pin}」が重複しています。`);
      const electricalType = String(row.electrical_type || "").trim().toLowerCase() || defaultElectricalType(data.functions, mcu, pin, functionName);
      if (!ELECTRICAL_TYPES.has(electricalType)) throw new Error(`CSV ${line}行目: 電気タイプ「${electricalType}」は使用できません。`);
      settings.set(pin, functionName);
      if (label) labelNames.set(pin, label);
      electricalTypes.set(pin, electricalType);
    });

    const labels = [...labelNames.values()];
    const duplicateLabels = [...new Set(labels.filter((label, index) => labels.indexOf(label) !== index))].sort();
    if (duplicateLabels.length) throw new Error(`任意指定のラベル名は重複できません: ${duplicateLabels.join(", ")}`);
    return { mcu, settings, labelNames, electricalTypes };
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function serializeSettingsCsv(options) {
    const { mcu, settings, labelNames, electricalTypes, functions } = options;
    const entries = settings instanceof Map ? [...settings.entries()] : Object.entries(settings || {});
    const labels = labelNames instanceof Map ? labelNames : new Map(Object.entries(labelNames || {}));
    const types = electricalTypes instanceof Map ? electricalTypes : new Map(Object.entries(electricalTypes || {}));
    const lines = ["mcu,pin,function,label,electrical_type"];
    entries
      .sort(([first], [second]) => first.localeCompare(second))
      .forEach(([pin, functionName]) => {
        const electricalType = types.get(pin) || defaultElectricalType(functions, mcu, pin, functionName);
        lines.push([mcu, pin, functionName, labels.get(pin) || "", electricalType].map(csvCell).join(","));
      });
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  return {
    ELECTRICAL_TYPES,
    SETTINGS_HEADERS,
    defaultElectricalType,
    parseCsv,
    serializeSettingsCsv,
    validateSettingsCsv,
  };
});
