const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseCsv,
  serializeSettingsCsv,
  validateSettingsCsv,
} = require("../pin-settings.js");

const data = {
  mcus: [{ mcu: "STM32F446RETx", package: "LQFP64" }],
  layouts: [
    { package: "LQFP64", pin_name: "PA9" },
    { package: "LQFP64", pin_name: "PA10" },
  ],
  functions: [
    { mcu: "STM32F446RETx", pin: "PA9", function: "USART1_TX", electrical_type: "output" },
    { mcu: "STM32F446RETx", pin: "PA10", function: "USART1_RX", electrical_type: "input" },
  ],
};

test("loads legacy 3-column settings with default electrical type", () => {
  const parsed = validateSettingsCsv(
    parseCsv("mcu,pin,function\nSTM32F446RETx,PA9,USART1_TX\n"),
    data,
  );
  assert.equal(parsed.settings.get("PA9"), "USART1_TX");
  assert.equal(parsed.labelNames.size, 0);
  assert.equal(parsed.electricalTypes.get("PA9"), "output");
});

test("loads 4-column and 5-column settings", () => {
  const four = validateSettingsCsv(
    parseCsv("mcu,pin,function,label\nSTM32F446RETx,PA9,USART1_TX,DEBUG_TX\n"),
    data,
  );
  assert.equal(four.labelNames.get("PA9"), "DEBUG_TX");
  assert.equal(four.electricalTypes.get("PA9"), "output");

  const five = validateSettingsCsv(
    parseCsv("mcu,pin,function,label,electrical_type\nSTM32F446RETx,PA10,USART1_RX,DEBUG_RX,passive\n"),
    data,
  );
  assert.equal(five.labelNames.get("PA10"), "DEBUG_RX");
  assert.equal(five.electricalTypes.get("PA10"), "passive");
});

test("always serializes a BOM-prefixed 5-column download", () => {
  const csv = serializeSettingsCsv({
    mcu: "STM32F446RETx",
    settings: new Map([["PA9", "USART1_TX"]]),
    labelNames: new Map([["PA9", "DEBUG_TX"]]),
    electricalTypes: new Map([["PA9", "output"]]),
    functions: data.functions,
  });
  assert.ok(csv.startsWith("\uFEFFmcu,pin,function,label,electrical_type\r\n"));
  assert.match(csv, /STM32F446RETx,PA9,USART1_TX,DEBUG_TX,output/);
});

test("rejects invalid rows", () => {
  assert.throws(
    () => validateSettingsCsv(parseCsv("mcu,pin,function\nSTM32F446RETx,PA8,USART1_TX\n"), data),
    /PA8/,
  );
  assert.throws(
    () => validateSettingsCsv(
      parseCsv("mcu,pin,function,label,electrical_type\nSTM32F446RETx,PA9,USART1_TX,,invalid\n"),
      data,
    ),
    /電気タイプ/,
  );
  assert.throws(
    () => validateSettingsCsv(
      parseCsv("pin,mcu,function\nPA9,STM32F446RETx,USART1_TX\n"),
      data,
    ),
    /CSV形式/,
  );
  assert.throws(
    () => validateSettingsCsv(
      parseCsv("mcu,pin,function\nSTM32F446RETx,PA9,USART1_TX\nSTM32F446RETx,PA9,USART1_TX\n"),
      data,
    ),
    /重複/,
  );
});
