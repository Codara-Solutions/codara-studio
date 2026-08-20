#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const classifierPath = path.join(
  ROOT,
  "src/renderer/src/components/file-preview/previewKind.ts",
);
const fullscreenPath = path.join(
  ROOT,
  "src/renderer/src/components/file-preview/PreviewFullscreenButton.tsx",
);

const built = esbuild.buildSync({
  entryPoints: [classifierPath],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const moduleShim = { exports: {} };
new Function("module", "exports", built.outputFiles[0].text)(moduleShim, moduleShim.exports);
const { previewKindForPath } = moduleShim.exports;

const expected = new Map([
  ["photo.AVIF", "image"],
  ["mockup.html", "html"],
  ["report.pdf", "pdf"],
  ["brief.docx", "docx"],
  ["deck.pptm", "pptx"],
  ["budget.xlsx", "spreadsheet"],
  ["forecast.XLSM", "spreadsheet"],
  ["template.xltx", "spreadsheet"],
  ["macro-template.xltm", "spreadsheet"],
]);
for (const [file, kind] of expected) {
  assert.equal(previewKindForPath(`/workspace/${file}`), kind, `${file} should preview as ${kind}`);
}

for (const file of ["legacy.xls", "binary.xlsb", "sheet.ods", "archive.zip"]) {
  assert.equal(previewKindForPath(`/workspace/${file}`), null, `${file} must not use an incompatible parser`);
}

const fullscreenSource = fs.readFileSync(fullscreenPath, "utf8");
assert.doesNotMatch(
  fullscreenSource,
  /requestFullscreen|exitFullscreen/,
  "preview focus mode must never resize the native Codara window",
);
assert.match(fullscreenSource, /event\.key !== "Escape"/, "preview focus mode must support Esc");

console.log("PASS preview routing covers safe Excel OOXML formats and rejects incompatible formats");
console.log("PASS preview focus mode stays inside Codara and restores with Esc");
