const fs = require("node:fs");
const path = require("node:path");

const siteRoot = path.resolve(__dirname, "..");
const names = ["mcu.csv", "pin_functions.csv", "pin_layout.csv", "pin_properties.csv", "reserved_pins.csv"];
const data = Object.fromEntries(
  names.map((name) => [
    `data/${name}`,
    fs.readFileSync(path.join(siteRoot, "data", name), "utf8").replace(/^\uFEFF/, ""),
  ]),
);

fs.writeFileSync(
  path.join(siteRoot, "data", "embedded-csv.js"),
  `window.EMBEDDED_CSV = ${JSON.stringify(data)};\n`,
  "utf8",
);
