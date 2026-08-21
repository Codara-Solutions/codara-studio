#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "electron-vite";
import { build as viteBuild } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The measured post-split static JS closure is ~2.30 MB raw. Keep a small,
// explicit allowance for normal application growth without permitting the old
// 5.62 MB eager closure to return unnoticed.
const STATIC_RAW_BUDGET_BYTES = 2_500_000;

const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  undefined,
  ROOT,
  "silent",
  true,
);
const renderer = loaded.config.renderer;
assert(renderer, "electron.vite.config.ts must define a renderer config");

const warnings = [];
const previousOnWarn = renderer.build?.rollupOptions?.onwarn;
const result = await viteBuild({
  ...renderer,
  configFile: false,
  logLevel: "silent",
  build: {
    ...renderer.build,
    write: false,
    emptyOutDir: false,
    rollupOptions: {
      ...renderer.build?.rollupOptions,
      onwarn(warning, defaultHandler) {
        warnings.push(warning);
        if (typeof previousOnWarn === "function") {
          previousOnWarn(warning, defaultHandler);
        }
      },
    },
  },
});

const outputs = Array.isArray(result) ? result : [result];
const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk");
assert(chunks.length > 0, "renderer analysis build must emit JavaScript chunks");

const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const entryChunks = chunks.filter((chunk) => chunk.isEntry);
assert(entryChunks.length > 0, "renderer analysis build must emit an entry chunk");

const staticFiles = new Set();
function visitStatic(fileName) {
  if (staticFiles.has(fileName)) return;
  const chunk = chunksByFile.get(fileName);
  if (!chunk) return;
  staticFiles.add(fileName);
  for (const importedFile of chunk.imports) visitStatic(importedFile);
}
for (const entry of entryChunks) visitStatic(entry.fileName);
const staticChunks = chunks.filter((chunk) => staticFiles.has(chunk.fileName));

function findChunkCycle() {
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  function visit(fileName) {
    if (visiting.has(fileName)) {
      const start = stack.indexOf(fileName);
      return [...stack.slice(start), fileName];
    }
    if (visited.has(fileName)) return null;
    visited.add(fileName);
    visiting.add(fileName);
    stack.push(fileName);
    const chunk = chunksByFile.get(fileName);
    for (const importedFile of chunk?.imports ?? []) {
      const cycle = visit(importedFile);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(fileName);
    return null;
  }
  for (const chunk of chunks) {
    const cycle = visit(chunk.fileName);
    if (cycle) return cycle;
  }
  return null;
}

const genericVendor = chunks.find(
  (chunk) =>
    chunk.name === "vendor" ||
    /^assets[\\/]vendor(?:-[^\\/]+)?\.js$/.test(chunk.fileName),
);
assert(!genericVendor, `generic vendor chunk returned as ${genericVendor?.fileName}`);

const normalizeId = (id) => id.replaceAll("\\", "/");
const reactModulePattern = /\/node_modules\/(?:react|react-dom)\//;
const reactOwners = chunks.filter((chunk) =>
  Object.keys(chunk.modules).some((id) => reactModulePattern.test(normalizeId(id))),
);
assert.equal(
  reactOwners.length,
  1,
  `React modules must have exactly one owning chunk; found ${reactOwners.map((chunk) => chunk.fileName).join(", ")}`,
);
assert.equal(
  reactOwners[0].name,
  "react-vendor",
  `React modules must remain in react-vendor, not ${reactOwners[0].fileName}`,
);

const reactModuleOwners = new Map();
for (const chunk of chunks) {
  for (const id of Object.keys(chunk.modules)) {
    if (!reactModulePattern.test(normalizeId(id))) continue;
    const owners = reactModuleOwners.get(id) ?? [];
    owners.push(chunk.fileName);
    reactModuleOwners.set(id, owners);
  }
}
for (const [id, owners] of reactModuleOwners) {
  assert.equal(owners.length, 1, `React module ${id} is duplicated across ${owners.join(", ")}`);
}

const featureOnlyPackages = [
  {
    label: "Mermaid",
    pattern: /\/node_modules\/(?:mermaid|@mermaid-js)\//,
  },
  {
    label: "QR code",
    pattern: /\/node_modules\/qrcode\//,
  },
  {
    label: "Markdown preview-only parsing",
    pattern: /\/node_modules\/(?:rehype-raw|rehype-sanitize|parse5)\//,
  },
  {
    label: "Excel preview parsing",
    pattern: /\/node_modules\/(?:read-excel-file|worker-f|saxen|fflate)\//,
  },
];
const closedSurfaceModules = [
  "components/WorkerSessionPicker.tsx",
  "components/RunSwitcher.tsx",
  "components/CreateCopyDialog.tsx",
  "components/CopyBranchDialogs.tsx",
  "shortcuts/ShortcutsDialog.tsx",
  "components/file-preview/SpreadsheetPreview.tsx",
];
const allModuleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));
const staticModuleIds = staticChunks.flatMap((chunk) => Object.keys(chunk.modules));
for (const feature of featureOnlyPackages) {
  assert(
    allModuleIds.some((id) => feature.pattern.test(normalizeId(id))),
    `${feature.label} packages were not found in the analysis bundle`,
  );
  const eagerIds = staticModuleIds.filter((id) => feature.pattern.test(normalizeId(id)));
  assert.equal(
    eagerIds.length,
    0,
    `${feature.label} packages entered the static closure:\n${eagerIds.join("\n")}`,
  );
}
for (const suffix of closedSurfaceModules) {
  const normalizedSuffix = `/src/renderer/src/${suffix}`;
  assert(
    allModuleIds.some((id) => normalizeId(id).endsWith(normalizedSuffix)),
    `${suffix} was not found in the analysis bundle`,
  );
  assert(
    !staticModuleIds.some((id) => normalizeId(id).endsWith(normalizedSuffix)),
    `${suffix} entered the startup closure`,
  );
}

const circularWarnings = warnings.filter((warning) =>
  /circular chunk/i.test(typeof warning === "string" ? warning : warning.message ?? ""),
);
assert.equal(
  circularWarnings.length,
  0,
  `renderer build emitted circular-chunk warnings:\n${circularWarnings
    .map((warning) => (typeof warning === "string" ? warning : warning.message))
    .join("\n")}`,
);
const chunkCycle = findChunkCycle();
assert(!chunkCycle, `renderer static chunk graph is circular: ${chunkCycle?.join(" -> ")}`);

const staticRawBytes = staticChunks.reduce(
  (total, chunk) => total + Buffer.byteLength(chunk.code),
  0,
);
assert(
  staticRawBytes <= STATIC_RAW_BUDGET_BYTES,
  `static renderer JS closure is ${staticRawBytes.toLocaleString()} bytes, above the ${STATIC_RAW_BUDGET_BYTES.toLocaleString()}-byte budget`,
);
const staticGzipBytes = staticChunks.reduce(
  (total, chunk) => total + gzipSync(chunk.code, { level: 9 }).byteLength,
  0,
);
const staticBrotliBytes = staticChunks.reduce(
  (total, chunk) =>
    total +
    brotliCompressSync(chunk.code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  0,
);

console.log("PASS renderer chunk graph has no generic vendor chunk or circular imports");
console.log(`PASS React is owned only by ${reactOwners[0].fileName}`);
console.log("PASS Mermaid, QR code, Markdown, and Excel preview-only packages remain outside the static closure");
console.log("PASS closed dialogs and pickers remain outside the startup closure");
console.log(
  `PASS static renderer JS closure ${staticRawBytes.toLocaleString()} raw / ${staticGzipBytes.toLocaleString()} gzip / ${staticBrotliBytes.toLocaleString()} Brotli (${staticChunks.length} chunks, ${STATIC_RAW_BUDGET_BYTES.toLocaleString()}-byte raw budget)`,
);
