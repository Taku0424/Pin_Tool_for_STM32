const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildKiCadCircuitTemplateClipboard,
  inspectKiCadCircuitTemplate,
  resolveLabelNames,
} = require("../kicad-template.js");

const CIRCUIT_TEMPLATE = fs.readFileSync(
  path.resolve(__dirname, "fixtures", "circuit-template.kicad_clipboard"),
  "utf8",
);

function build(source, options = {}) {
  return buildKiCadCircuitTemplateClipboard({
    clipboardText: source,
    mcuName: "STM32F446RETx",
    settings: { PA9: "GPIO_Input" },
    labelNames: { PA9: "USER_BUTTON" },
    electricalTypes: { PA9: "input" },
    labelType: "global",
    uuidFactory: () => "99999999-9999-4999-8999-999999999999",
    ...options,
  });
}

test("rootless KiCad selection is inspected", () => {
  const inspection = inspectKiCadCircuitTemplate(CIRCUIT_TEMPLATE, "STM32F446RETx");
  assert.deepEqual(
    {
      mcuName: inspection.mcuName,
      reference: inspection.reference,
      labelCount: inspection.labelCount,
      symbolCount: inspection.symbolCount,
    },
    { mcuName: "STM32F446RETx", reference: "U1", labelCount: 5, symbolCount: 2 },
  );
  assert.throws(
    () => inspectKiCadCircuitTemplate(CIRCUIT_TEMPLATE, "STM32F303K8Tx"),
    /画面では「STM32F303K8Tx」/,
  );
});

test("renames all matching labels while preserving the surrounding circuit", () => {
  const result = build(CIRCUIT_TEMPLATE);
  const expected = CIRCUIT_TEMPLATE
    .replace(
      '(global_label "OLD_BUTTON"\n    (shape bidirectional)',
      '(global_label "USER_BUTTON"\n    (shape input)',
    )
    .replace(
      '(hierarchical_label "OLD_BUTTON"\n    (shape bidirectional)',
      '(hierarchical_label "USER_BUTTON"\n    (shape input)',
    );
  assert.equal(result.text, expected);
  assert.equal(result.count, 2);
  assert.deepEqual(result.conflicts, []);
  assert.match(result.text, /\(global_label "USER_BUTTON"\s+\(shape input\)/);
  assert.match(result.text, /\(hierarchical_label "USER_BUTTON"\s+\(shape input\)/);
  assert.match(result.text, /\(property "Reference" "R1"/);
  assert.match(result.text, /\(global_label "VDD"\s+\(shape power_in\)/);
  assert.match(result.text, /\(global_label "NRST"/);
});

test("keeps the source byte-for-byte when no pins are configured", () => {
  const result = buildKiCadCircuitTemplateClipboard({
    clipboardText: CIRCUIT_TEMPLATE,
    mcuName: "STM32F446RETx",
    settings: {},
  });
  assert.equal(result.text, CIRCUIT_TEMPLATE);
  assert.equal(result.count, 0);
});

test("does not choose between two destinations for one source label", () => {
  const sharedNet = CIRCUIT_TEMPLATE.replace('"OLD_UART"', '"OLD_BUTTON"');
  const result = build(sharedNet, {
    settings: { PA9: "GPIO_Input", PA10: "USART1_RX" },
    labelNames: { PA9: "BUTTON", PA10: "UART_RX" },
    electricalTypes: { PA9: "input", PA10: "input" },
  });
  assert.equal(result.text, sharedNet);
  assert.equal(result.count, 0);
  assert.ok(result.conflicts.some((message) => message.includes("複数の変更先")));
});

test("protects power labels but permits similarly prefixed signal names", () => {
  const protectedSource = CIRCUIT_TEMPLATE.replaceAll('"OLD_BUTTON"', '"VDD"');
  const protectedResult = build(protectedSource);
  assert.equal(protectedResult.text, protectedSource);
  assert.ok(protectedResult.conflicts.some((message) => message.includes("保護対象")));

  const signalSource = CIRCUIT_TEMPLATE.replaceAll('"OLD_BUTTON"', '"VDD_SENSE"');
  const signalResult = build(signalSource, { labelNames: { PA9: "SUPPLY_MONITOR" } });
  assert.equal(signalResult.count, 2);
  assert.match(signalResult.text, /"SUPPLY_MONITOR"/);
});

test("follows a T junction but not a crossing without an explicit point", () => {
  const branch = `(wire
    (pts (xy 43.18 48.26) (xy 43.18 45.72))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000008")
)
`;
  const branched = CIRCUIT_TEMPLATE
    .replace('(global_label "OLD_BUTTON"', `${branch}(global_label "OLD_BUTTON"`)
    .replace("(at 43.18 48.26 180)", "(at 43.18 45.72 180)");
  assert.equal(build(branched, { labelNames: { PA9: "BRANCH_INPUT" } }).count, 2);

  const crossing = `(wire
    (pts (xy 42 46) (xy 42 50))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000009")
)
(global_label "CROSSING_NET"
    (shape bidirectional)
    (at 42 46 90)
    (effects (font (size 1.27 1.27)))
    (uuid "10000000-0000-4000-8000-000000000010")
)
`;
  const crossed = CIRCUIT_TEMPLATE.replace('(global_label "OLD_BUTTON"', `${crossing}(global_label "OLD_BUTTON"`);
  const crossingResult = build(crossed, { labelNames: { PA9: "BUTTON" } });
  assert.match(crossingResult.text, /\(global_label "CROSSING_NET"/);
  assert.doesNotMatch(crossingResult.text, /\(global_label "BUTTON"\s+\(shape bidirectional\)\s+\(at 42 46/);
});

test("adds a label to an unlabeled GPIO net", () => {
  const unlabeled = CIRCUIT_TEMPLATE
    .replace(/\(global_label "OLD_BUTTON"[\s\S]*?\n\)/, "")
    .replace(/\(hierarchical_label "OLD_BUTTON"[\s\S]*?\n\)/, "");
  const result = build(unlabeled, { labelType: "hierarchical" });
  assert.equal(result.count, 1);
  assert.match(result.text, /\(hierarchical_label "USER_BUTTON"/);
  assert.match(result.text, /\(shape input\)/);
  assert.match(result.text, /\(at 45\.72 48\.26 180\)/);
});

test("leaves a shared unlabeled net unchanged when destinations disagree", () => {
  const unlabeled = CIRCUIT_TEMPLATE
    .replace(/\(global_label "OLD_BUTTON"[\s\S]*?\n\)/, "")
    .replace(/\(hierarchical_label "OLD_BUTTON"[\s\S]*?\n\)/, "")
    .replace(/\(global_label "OLD_UART"[\s\S]*?\n\)/, "");
  const bridge = `(wire (pts (xy 45.72 48.26) (xy 50 48.26)) (uuid "91000000-0000-4000-8000-000000000001"))
(wire (pts (xy 50 48.26) (xy 50 50.8)) (uuid "91000000-0000-4000-8000-000000000002"))
(wire (pts (xy 50 50.8) (xy 55.88 50.8)) (uuid "91000000-0000-4000-8000-000000000003"))
`;
  const source = `${unlabeled}${bridge}`;
  const result = build(source, {
    settings: { PA9: "GPIO_Input", PA10: "USART1_RX" },
    labelNames: { PA9: "BUTTON", PA10: "UART_RX" },
    electricalTypes: { PA9: "input", PA10: "input" },
  });
  assert.equal(result.text, source);
  assert.equal(result.count, 0);
  assert.ok(result.conflicts.some((message) => message.includes("ラベルのない同じ配線")));
});

test("reports missing pins and respects no-connect markers", () => {
  const missing = build(CIRCUIT_TEMPLATE, {
    settings: { PA8: "GPIO_Input" },
    labelNames: { PA8: "MISSING" },
    electricalTypes: { PA8: "input" },
  });
  assert.deepEqual(missing.missingPins, ["PA8"]);

  const noConnect = `(no_connect
    (at 45.72 48.26)
    (uuid "92000000-0000-4000-8000-000000000001")
)
${CIRCUIT_TEMPLATE}`;
  const blocked = build(noConnect);
  assert.equal(blocked.text, noConnect);
  assert.ok(blocked.conflicts.some((message) => message.includes("未接続マーク")));
});

test("resolves automatic duplicate labels and rejects duplicate custom labels", () => {
  assert.deepEqual(
    resolveLabelNames({ PA0: "GPIO_Input", PA1: "GPIO_Input" }),
    { PA0: "GPIO_Input_PA0", PA1: "GPIO_Input_PA1" },
  );
  assert.throws(
    () => resolveLabelNames(
      { PA0: "GPIO_Input", PA1: "GPIO_Input" },
      { PA0: "BUTTON", PA1: "BUTTON" },
    ),
    /重複できません/,
  );
});
