(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KiCadTemplate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GPIO_RE = /(?<![A-Z0-9])P[A-K][0-9]{1,2}(?![0-9])/i;
  const SYMBOL_PART_RE = /_(\d+)_(\d+)$/;
  const POSITION_EPSILON = 0.0001;
  const LABEL_SHAPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"]);
  const PROTECTED_TEMPLATE_NET_RE = /^(?:VCC|VCCA|VCCIO[0-9]*|VDD|VDDA|VDDIO[0-9]*|VSS|VSSA|VSSIO[0-9]*|GND|AGND|DGND|VBAT|VCAP[0-9]*|VREF[+-]?|NRST|BOOT[0-9]*|\+?[0-9]+(?:V[0-9]+)?)$/i;

  class SchematicFormatError extends Error {
    constructor(message) {
      super(message);
      this.name = "SchematicFormatError";
    }
  }

  class SExpr {
    constructor(items = [], start = 0, end = 0) {
      this.items = items;
      this.start = start;
      this.end = end;
    }

    get head() {
      return this.items.length && this.items[0].kind === "atom" ? this.items[0].value : "";
    }

    children(head) {
      const nodes = this.items.filter((item) => item.kind === "node");
      return head === undefined ? nodes : nodes.filter((node) => node.head === head);
    }

    child(head) {
      return this.children(head)[0] || null;
    }

    atom(index, fallback = "") {
      const atoms = this.items.filter((item) => item.kind === "atom");
      return index < atoms.length ? atoms[index].value : fallback;
    }
  }

  function atom(value, quoted, start, end) {
    return { kind: "atom", value, quoted, start, end };
  }

  function parseSexpr(text) {
    const length = text.length;

    function skipSpace(index) {
      while (index < length && /\s/.test(text[index])) index += 1;
      return index;
    }

    function parseString(startIndex) {
      const start = startIndex;
      let index = startIndex + 1;
      let value = "";
      const escapes = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
      while (index < length) {
        const char = text[index];
        if (char === '"') return [atom(value, true, start, index + 1), index + 1];
        if (char === "\\") {
          index += 1;
          if (index >= length) break;
          const escaped = text[index];
          value += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
          index += 1;
          continue;
        }
        value += char;
        index += 1;
      }
      throw new SchematicFormatError(`文字列が閉じられていません（位置 ${start}）。`);
    }

    function parseAtom(startIndex) {
      let index = startIndex;
      while (index < length && !/\s/.test(text[index]) && !"()".includes(text[index])) index += 1;
      if (startIndex === index) throw new SchematicFormatError(`値を読み取れません（位置 ${index}）。`);
      return [atom(text.slice(startIndex, index), false, startIndex, index), index];
    }

    function parseNode(startIndex) {
      if (startIndex >= length || text[startIndex] !== "(") {
        throw new SchematicFormatError(`'(' が必要です（位置 ${startIndex}）。`);
      }
      const node = new SExpr([], startIndex, 0);
      node.kind = "node";
      let index = startIndex + 1;
      while (true) {
        index = skipSpace(index);
        if (index >= length) throw new SchematicFormatError(`式が閉じられていません（位置 ${node.start}）。`);
        if (text[index] === ")") {
          node.end = index + 1;
          return [node, index + 1];
        }
        let parsed;
        if (text[index] === "(") parsed = parseNode(index);
        else if (text[index] === '"') parsed = parseString(index);
        else parsed = parseAtom(index);
        node.items.push(parsed[0]);
        index = parsed[1];
      }
    }

    const start = skipSpace(0);
    if (start >= length) throw new SchematicFormatError("回路データが空です。");
    const [rootNode, end] = parseNode(start);
    if (text.slice(skipSpace(end)).trim()) throw new SchematicFormatError("回路データの後ろに解釈できない内容があります。");
    return rootNode;
  }

  function parseClipboardSelection(clipboardText) {
    const sourceText = String(clipboardText || "").replace(/^\uFEFF/, "");
    if (!sourceText.trim()) throw new Error("貼り付け欄が空です。KiCadで回路をコピーして貼り付けてください。");

    let rootNode = null;
    try {
      rootNode = parseSexpr(sourceText);
    } catch (error) {
      if (!(error instanceof SchematicFormatError)) throw error;
    }
    if (rootNode && ["kicad_sch", "clipboard"].includes(rootNode.head)) {
      return { sourceText, root: rootNode, sourceOffset: 0 };
    }

    const prefix = "(clipboard\n";
    try {
      rootNode = parseSexpr(`${prefix}${sourceText}\n)`);
    } catch (error) {
      throw new Error("貼り付け内容をKiCad回路データとして読み取れません。KiCadの回路図エディターでSTM32を含む回路を選択してコピーしてください。");
    }
    return { sourceText, root: rootNode, sourceOffset: prefix.length };
  }

  function childAtom(node, head, fallback = "") {
    const child = node.child(head);
    return child ? child.atom(1, fallback) : fallback;
  }

  function childInt(node, head, fallback) {
    const parsed = Number.parseInt(childAtom(node, head), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function propertyValue(node, name) {
    const prop = node.children("property").find((item) => item.atom(1) === name);
    return prop ? prop.atom(2) : "";
  }

  function floatAtom(node, index) {
    const value = Number(node.atom(index, "0"));
    if (!Number.isFinite(value)) throw new SchematicFormatError(`'${node.head}' 内の数値を読み取れません。`);
    return value;
  }

  function logicalPinName(rawName) {
    const match = String(rawName).toUpperCase().match(GPIO_RE);
    return match ? match[0].toUpperCase() : String(rawName).trim();
  }

  function transformVector(localX, localY, rotation, mirror) {
    let x = localX;
    let y = -localY;
    if (mirror === "x") x = -x;
    else if (mirror === "y") y = -y;
    const radians = rotation * Math.PI / 180;
    return [
      Math.cos(radians) * x + Math.sin(radians) * y,
      -Math.sin(radians) * x + Math.cos(radians) * y,
    ];
  }

  function transformPoint(localX, localY, originX, originY, rotation, mirror) {
    const [x, y] = transformVector(localX, localY, rotation, mirror);
    return [originX + x, originY + y];
  }

  function cleanFloat(value) {
    if (Math.abs(value) < 1e-9) return 0;
    return Math.round(value * 1e6) / 1e6;
  }

  function pinNodes(definition, unit) {
    const pins = [...definition.children("pin")];
    for (const part of definition.children("symbol")) {
      const match = part.atom(1).match(SYMBOL_PART_RE);
      if (!match) continue;
      const partUnit = Number(match[1]);
      const convert = Number(match[2]);
      if ((partUnit === 0 || partUnit === unit) && convert === 1) pins.push(...part.children("pin"));
    }
    return pins;
  }

  function readComponents(rootNode) {
    const libSymbols = rootNode.child("lib_symbols");
    const definitions = new Map();
    for (const node of libSymbols ? libSymbols.children("symbol") : []) {
      if (node.atom(1)) definitions.set(node.atom(1), node);
    }
    const components = new Map();

    for (const instance of rootNode.children("symbol")) {
      const libId = childAtom(instance, "lib_id");
      const reference = propertyValue(instance, "Reference");
      const value = propertyValue(instance, "Value");
      if (!libId || !reference) continue;
      const unit = childInt(instance, "unit", 1);
      const at = instance.child("at");
      if (!at) continue;
      const originX = floatAtom(at, 1);
      const originY = floatAtom(at, 2);
      const rotation = floatAtom(at, 3);
      const mirrorNode = instance.child("mirror");
      const mirror = mirrorNode ? mirrorNode.atom(1) : "";
      const instancePinNumbers = new Set(instance.children("pin").map((pin) => pin.atom(1)).filter(Boolean));
      const definition = definitions.get(libId);
      if (!definition) continue;

      const pins = [];
      for (const pinNode of pinNodes(definition, unit)) {
        const rawName = childAtom(pinNode, "name");
        const number = childAtom(pinNode, "number");
        const pinAt = pinNode.child("at");
        if (!rawName || !number || !pinAt) continue;
        if (instancePinNumbers.size && !instancePinNumbers.has(number)) continue;
        const localX = floatAtom(pinAt, 1);
        const localY = floatAtom(pinAt, 2);
        const pinRotation = floatAtom(pinAt, 3);
        const [x, y] = transformPoint(localX, localY, originX, originY, rotation, mirror);
        const [directionX, directionY] = transformVector(
          Math.cos(pinRotation * Math.PI / 180),
          Math.sin(pinRotation * Math.PI / 180),
          rotation,
          mirror,
        );
        const angle = ((Math.round(Math.atan2(-directionY, -directionX) * 180 / Math.PI) % 360) + 360) % 360;
        pins.push({
          name: logicalPinName(rawName),
          rawName,
          number,
          x: cleanFloat(x),
          y: cleanFloat(y),
          labelAngle: angle,
          unit,
        });
      }

      const key = `${reference}\u0000${value}\u0000${libId}`;
      if (!components.has(key)) components.set(key, { reference, value, libId, pins: [] });
      const component = components.get(key);
      const known = new Set(component.pins.map((pin) => `${pin.number}\u0000${pin.unit}`));
      for (const pin of pins) {
        const pinKey = `${pin.number}\u0000${pin.unit}`;
        if (!known.has(pinKey)) {
          component.pins.push(pin);
          known.add(pinKey);
        }
      }
    }
    return [...components.values()].sort((a, b) => a.reference.localeCompare(b.reference, undefined, { numeric: true }));
  }

  function isStm32(component) {
    return component.value.toUpperCase().includes("STM32") || component.libId.toUpperCase().includes("STM32");
  }

  function componentMcuName(component) {
    return component.value.toUpperCase().includes("STM32") ? component.value.trim() : component.libId.split(":").pop();
  }

  function componentMatchesMcu(component, mcuName) {
    const expected = String(mcuName).trim().toUpperCase();
    return [component.value, component.libId.split(":").pop()].some((value) => value.trim().toUpperCase() === expected);
  }

  function parseLabel(node) {
    const at = node.child("at");
    if (!at) return null;
    const uuidNode = node.child("uuid");
    return {
      node,
      kind: node.head,
      text: node.atom(1),
      x: floatAtom(at, 1),
      y: floatAtom(at, 2),
      angle: ((Math.round(floatAtom(at, 3)) % 360) + 360) % 360,
      uuid: uuidNode ? uuidNode.atom(1) : "",
    };
  }

  function templateLabels(rootNode) {
    return ["label", "global_label", "hierarchical_label"]
      .flatMap((head) => rootNode.children(head))
      .map(parseLabel)
      .filter(Boolean);
  }

  function parseWire(node) {
    const points = node.child("pts");
    if (!points) return null;
    const coordinates = points.children("xy");
    if (coordinates.length < 2) return null;
    return {
      start: [floatAtom(coordinates[0], 1), floatAtom(coordinates[0], 2)],
      end: [floatAtom(coordinates[coordinates.length - 1], 1), floatAtom(coordinates[coordinates.length - 1], 2)],
    };
  }

  function positionKey(x, y) {
    return `${Math.round(x / POSITION_EPSILON)},${Math.round(y / POSITION_EPSILON)}`;
  }

  function samePosition(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) <= POSITION_EPSILON && Math.abs(y1 - y2) <= POSITION_EPSILON;
  }

  function pointOnSegment(point, start, end) {
    const [px, py] = point;
    const [x1, y1] = start;
    const [x2, y2] = end;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const cross = (px - x1) * dy - (py - y1) * dx;
    const scale = Math.max(Math.abs(dx), Math.abs(dy), 1);
    if (Math.abs(cross) > POSITION_EPSILON * scale) return false;
    return (
      Math.min(x1, x2) - POSITION_EPSILON <= px && px <= Math.max(x1, x2) + POSITION_EPSILON &&
      Math.min(y1, y2) - POSITION_EPSILON <= py && py <= Math.max(y1, y2) + POSITION_EPSILON
    );
  }

  function buildTemplateConnectivity(wires, labels, junctions, extraPoints) {
    const points = new Map();
    for (const wire of wires) {
      points.set(positionKey(...wire.start), wire.start);
      points.set(positionKey(...wire.end), wire.end);
    }
    for (const label of labels) points.set(positionKey(label.x, label.y), [label.x, label.y]);
    for (const point of junctions) points.set(positionKey(...point), point);
    for (const point of extraPoints) points.set(positionKey(...point), point);

    const parent = new Map([...points.keys()].map((key) => [key, key]));
    function find(inputKey) {
      let key = inputKey;
      while (parent.get(key) !== key) {
        parent.set(key, parent.get(parent.get(key)));
        key = parent.get(key);
      }
      return key;
    }
    function union(first, second) {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot !== secondRoot) parent.set(secondRoot, firstRoot);
    }

    const entries = [...points.entries()];
    for (const wire of wires) {
      const onSegment = entries.filter(([, point]) => pointOnSegment(point, wire.start, wire.end)).map(([key]) => key);
      if (onSegment.length > 1) {
        for (let index = 1; index < onSegment.length; index += 1) union(onSegment[0], onSegment[index]);
      }
    }
    const roots = new Map([...points.keys()].map((key) => [key, find(key)]));
    return { rootAt: (x, y) => roots.get(positionKey(x, y)) || positionKey(x, y) };
  }

  function toRecord(value) {
    if (value instanceof Map) return Object.fromEntries(value);
    return { ...(value || {}) };
  }

  function resolveLabelNames(settingsInput, customNamesInput = {}) {
    const settings = toRecord(settingsInput);
    const customNames = toRecord(customNamesInput);
    const custom = {};
    for (const pin of Object.keys(settings)) {
      const name = String(customNames[pin] || "").trim();
      if (name) custom[pin] = name;
    }
    const customCounts = new Map();
    for (const name of Object.values(custom)) customCounts.set(name, (customCounts.get(name) || 0) + 1);
    const duplicateCustom = [...customCounts].filter(([, count]) => count > 1).map(([name]) => name).sort();
    if (duplicateCustom.length) throw new Error(`任意指定のラベル名は重複できません: ${duplicateCustom.join(", ")}`);

    const functionCounts = new Map();
    for (const fn of Object.values(settings)) functionCounts.set(fn, (functionCounts.get(fn) || 0) + 1);
    const resolved = { ...custom };
    const used = new Set(Object.values(custom));
    for (const pin of Object.keys(settings).sort()) {
      if (Object.prototype.hasOwnProperty.call(custom, pin)) continue;
      const base = String(settings[pin]).trim();
      if (!base) throw new Error(`${pin}: 機能名が空です。`);
      let candidate = base;
      if (functionCounts.get(settings[pin]) > 1 || used.has(candidate)) candidate = `${base}_${pin}`;
      let unique = candidate;
      let suffix = 2;
      while (used.has(unique)) {
        unique = `${candidate}_${suffix}`;
        suffix += 1;
      }
      resolved[pin] = unique;
      used.add(unique);
    }
    return resolved;
  }

  function inspectKiCadCircuitTemplate(clipboardText, expectedMcuName = "") {
    const { sourceText, root: rootNode } = parseClipboardSelection(clipboardText);
    const components = readComponents(rootNode);
    const stm32Components = components.filter(isStm32);
    if (!stm32Components.length) {
      throw new Error("貼り付け内容にSTM32シンボルが見つかりません。KiCadでマイコンと周辺回路を選択してコピーしてください。");
    }
    if (stm32Components.length > 1) {
      const references = stm32Components.map((component) => component.reference).join(", ");
      throw new Error(`貼り付ける回路にはSTM32シンボルを1個だけ含めてください。現在は${stm32Components.length}個あります（${references}）。`);
    }
    const component = stm32Components[0];
    const detectedMcu = componentMcuName(component);
    if (expectedMcuName && !componentMatchesMcu(component, expectedMcuName)) {
      throw new Error(`貼り付けた回路のMCUは「${detectedMcu}」ですが、画面では「${expectedMcuName}」が選択されています。`);
    }
    return {
      mcuName: expectedMcuName || detectedMcu,
      reference: component.reference,
      labelCount: templateLabels(rootNode).length,
      symbolCount: components.length,
      pinCount: component.pins.length,
      sourceLength: sourceText.length,
    };
  }

  function nodeValueAtom(node, index) {
    if (!node) return null;
    const atoms = node.items.filter((item) => item.kind === "atom");
    return index < atoms.length ? atoms[index] : null;
  }

  function escapeString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  function formatNumber(value) {
    const fixed = cleanFloat(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return fixed || "0";
  }

  function newlineFor(text) {
    return text.includes("\r\n") ? "\r\n" : "\n";
  }

  function createUuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  function formatLabel(text, pin, labelUuid, labelType, electricalType, newline) {
    const nodeName = labelType === "global" ? "global_label" : "hierarchical_label";
    const justify = [0, 90].includes(pin.labelAngle) ? "left" : "right";
    const lines = [
      `\t(${nodeName} "${escapeString(text)}"`,
      `\t\t(shape ${electricalType})`,
      `\t\t(at ${formatNumber(pin.x)} ${formatNumber(pin.y)} ${pin.labelAngle})`,
    ];
    if (labelType === "global") lines.push("\t\t(fields_autoplaced yes)");
    lines.push(
      "\t\t(effects",
      "\t\t\t(font",
      "\t\t\t\t(size 1.27 1.27)",
      "\t\t\t)",
      `\t\t\t(justify ${justify})`,
      "\t\t)",
      `\t\t(uuid "${labelUuid}")`,
    );
    if (labelType === "global") {
      lines.push(
        '\t\t(property "Intersheetrefs" "${INTERSHEET_REFS}"',
        `\t\t\t(at ${formatNumber(pin.x)} ${formatNumber(pin.y)} ${pin.labelAngle})`,
        "\t\t\t(effects",
        "\t\t\t\t(font",
        "\t\t\t\t\t(size 1.27 1.27)",
        "\t\t\t\t)",
        `\t\t\t\t(justify ${justify})`,
        "\t\t\t\t(hide yes)",
        "\t\t\t)",
        "\t\t)",
      );
    }
    lines.push("\t)");
    return `${lines.join(newline)}${newline}`;
  }

  function buildKiCadCircuitTemplateClipboard(options) {
    const {
      clipboardText,
      mcuName,
      labelType = "global",
      uuidFactory = createUuid,
    } = options || {};
    const settings = toRecord(options && options.settings);
    const labelNames = toRecord(options && options.labelNames);
    const electricalTypes = toRecord(options && options.electricalTypes);
    const { sourceText, root: rootNode, sourceOffset } = parseClipboardSelection(clipboardText);
    const inspection = inspectKiCadCircuitTemplate(sourceText, mcuName);
    const components = readComponents(rootNode);
    const component = components.find(isStm32);
    const labels = templateLabels(rootNode);
    const wires = rootNode.children("wire").map(parseWire).filter(Boolean);
    const junctions = rootNode.children("junction").map((node) => node.child("at")).filter(Boolean).map((at) => [floatAtom(at, 1), floatAtom(at, 2)]);

    const resolvedNames = resolveLabelNames(settings, labelNames);
    const resolvedShapes = Object.fromEntries(Object.keys(settings).map((pin) => [
      pin,
      String(electricalTypes[pin] || "bidirectional").trim().toLowerCase(),
    ]));
    const invalidShapes = [...new Set(Object.values(resolvedShapes).filter((shape) => !LABEL_SHAPES.has(shape)))].sort();
    if (invalidShapes.length) throw new Error(`無効なラベル電気タイプです: ${invalidShapes.join(", ")}`);
    if (!["global", "hierarchical"].includes(labelType)) throw new Error("ラベル種類はグローバルラベルまたは階層ラベルを選択してください。");

    const result = {
      text: sourceText,
      count: 0,
      existing: 0,
      symbolName: inspection.mcuName,
      missingPins: [],
      conflicts: [],
    };
    const pinsByName = new Map();
    for (const pin of component.pins) {
      const key = pin.name.toUpperCase();
      if (!pinsByName.has(key)) pinsByName.set(key, []);
      pinsByName.get(key).push(pin);
    }
    const noConnects = rootNode.children("no_connect").map((node) => node.child("at")).filter(Boolean).map((at) => [floatAtom(at, 1), floatAtom(at, 2)]);
    const configuredPins = new Map();
    for (const configuredPin of Object.keys(settings).sort()) {
      if (!new RegExp(`^${GPIO_RE.source}$`, "i").test(configuredPin.trim().toUpperCase())) {
        result.conflicts.push(`${configuredPin}: GPIOではないため変更しませんでした。`);
        continue;
      }
      const candidates = pinsByName.get(configuredPin.toUpperCase()) || [];
      if (!candidates.length) {
        result.missingPins.push(configuredPin);
        continue;
      }
      if (candidates.length > 1) {
        result.conflicts.push(`${configuredPin}: 複数のシンボルピンが一致しました（${candidates.map((pin) => pin.number).join(", ")}）`);
        continue;
      }
      const pin = candidates[0];
      if (noConnects.some(([x, y]) => samePosition(x, y, pin.x, pin.y))) {
        result.conflicts.push(`${configuredPin}: 未接続マークがあるためラベルを追加しませんでした。`);
        continue;
      }
      configuredPins.set(configuredPin, pin);
    }

    const connectivity = buildTemplateConnectivity(
      wires,
      labels,
      junctions,
      [...configuredPins.values()].map((pin) => [pin.x, pin.y]),
    );
    const labelsByRoot = new Map();
    for (const label of labels) {
      const rootKey = connectivity.rootAt(label.x, label.y);
      if (!labelsByRoot.has(rootKey)) labelsByRoot.set(rootKey, []);
      labelsByRoot.get(rootKey).push(label);
    }

    const requestedChanges = new Map();
    const unlabeledNets = new Map();
    for (const [configuredPin, pin] of configuredPins) {
      const rootKey = connectivity.rootAt(pin.x, pin.y);
      const connected = labelsByRoot.get(rootKey) || [];
      if (!connected.length) {
        if (!unlabeledNets.has(rootKey)) unlabeledNets.set(rootKey, []);
        unlabeledNets.get(rootKey).push([configuredPin, pin, resolvedNames[configuredPin], resolvedShapes[configuredPin]]);
        continue;
      }
      const protectedNames = [...new Set(connected.filter((label) => PROTECTED_TEMPLATE_NET_RE.test(label.text.trim())).map((label) => label.text))].sort();
      if (protectedNames.length) {
        result.conflicts.push(`${configuredPin}: 保護対象のラベル「${protectedNames.join(", ")}」は変更しませんでした。`);
        continue;
      }
      for (const sourceName of new Set(connected.map((label) => label.text))) {
        if (!requestedChanges.has(sourceName)) requestedChanges.set(sourceName, []);
        requestedChanges.get(sourceName).push([configuredPin, resolvedNames[configuredPin], resolvedShapes[configuredPin]]);
      }
    }

    const acceptedChanges = new Map();
    for (const sourceName of [...requestedChanges.keys()].sort()) {
      const requests = requestedChanges.get(sourceName);
      const targets = new Map(requests.map(([, target, shape]) => [`${target}\u0000${shape}`, [target, shape]]));
      if (targets.size > 1) {
        const details = [...new Set(requests.map(([pin, target]) => `${pin}→${target}`))].sort().join(", ");
        result.conflicts.push(`元のラベル「${sourceName}」に複数の変更先があります（${details}）。`);
        continue;
      }
      acceptedChanges.set(sourceName, [...targets.values()][0]);
    }

    const generatedLabels = [];
    for (const requests of unlabeledNets.values()) {
      const targets = new Map(requests.map(([, , target, shape]) => [`${target}\u0000${shape}`, [target, shape]]));
      if (targets.size > 1) {
        const details = [...requests].sort((a, b) => a[0].localeCompare(b[0])).map(([pin, , target]) => `${pin}→${target}`).join(", ");
        result.conflicts.push(`ラベルのない同じ配線に複数の変更先があります（${details}）。`);
        continue;
      }
      const [targetName, targetShape] = [...targets.values()][0];
      const [, anchorPin] = [...requests].sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y || a[0].localeCompare(b[0]))[0];
      generatedLabels.push(formatLabel(targetName, anchorPin, uuidFactory(), labelType, targetShape, newlineFor(sourceText)));
      result.count += 1;
    }

    const edits = [];
    for (const label of labels) {
      const change = acceptedChanges.get(label.text);
      if (!change) continue;
      const [targetName, targetShape] = change;
      let changed = false;
      const textAtom = nodeValueAtom(label.node, 1);
      if (textAtom && label.text !== targetName) {
        edits.push([textAtom.start - sourceOffset, textAtom.end - sourceOffset, `"${escapeString(targetName)}"`]);
        changed = true;
      }
      const shapeNode = label.node.child("shape");
      const shapeAtom = shapeNode ? nodeValueAtom(shapeNode, 1) : null;
      if (shapeAtom && shapeAtom.value !== targetShape) {
        edits.push([shapeAtom.start - sourceOffset, shapeAtom.end - sourceOffset, targetShape]);
        changed = true;
      }
      if (changed) result.count += 1;
      else result.existing += 1;
    }

    if (generatedLabels.length) {
      const generatedText = generatedLabels.join("");
      if (["kicad_sch", "clipboard"].includes(rootNode.head) && sourceOffset === 0) {
        edits.push([rootNode.end - 1, rootNode.end - 1, generatedText]);
      } else {
        const separator = sourceText.endsWith("\n") || sourceText.endsWith("\r") ? "" : newlineFor(sourceText);
        edits.push([sourceText.length, sourceText.length, `${separator}${generatedText}`]);
      }
    }

    let updatedText = sourceText;
    edits.sort((a, b) => b[0] - a[0]);
    for (const [start, end, replacement] of edits) {
      if (start < 0 || end > sourceText.length) throw new SchematicFormatError("回路内のラベル位置を読み取れませんでした。");
      updatedText = `${updatedText.slice(0, start)}${replacement}${updatedText.slice(end)}`;
    }
    parseClipboardSelection(updatedText);
    result.text = updatedText;
    return result;
  }

  return {
    LABEL_SHAPES,
    SchematicFormatError,
    buildKiCadCircuitTemplateClipboard,
    inspectKiCadCircuitTemplate,
    parseClipboardSelection,
    parseSexpr,
    resolveLabelNames,
  };
});
