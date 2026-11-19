"use strict";

// Test harnesses bundle the real run-store.ts and replace its heavy imports
// (the Pi runtime, the backend registry, ...) with small stubs that export
// only what that test needs. When run-store starts importing one more name
// from such a module, every stub without it breaks the bundle ("No matching
// export"), in tests that have nothing to do with the change.
//
// completeStubExports() appends, for each export of the REAL module the stub
// does not define, a function that throws only if it is called. A test still
// fails loudly when it reaches something it did not stub, and no longer
// fails to build when a neighbour adds an import.
//
//   contents: completeStubExports(args.path, STUBS[args.path])

const fs = require("node:fs");
const path = require("node:path");

const ORCHESTRATION = path.resolve(__dirname, "..", "src", "main", "orchestration");

function realModuleFile(specifier, fromDir) {
  const base = path.resolve(fromDir, specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The value exports a TypeScript module declares (types are erased). */
function exportedNames(source) {
  const names = new Set();
  // Not anchored at a line start: test stubs often put several on one line.
  const declaration = /(?<![\w$.])export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(declaration)) names.add(match[1]);
  for (const match of source.matchAll(/(?<![\w$.])export\s+\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const alias = item.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
    }
  }
  if (/(?<![\w$.])export\s+default\b/.test(source)) names.add("default");
  return names;
}

function completeStubExports(specifier, contents, fromDir = ORCHESTRATION) {
  if (typeof contents !== "string" || !specifier.startsWith(".")) return contents;
  // A CommonJS stub cannot take ESM exports next to it.
  if (/\bmodule\.exports\b/.test(contents)) return contents;
  const real = realModuleFile(specifier, fromDir);
  if (!real) return contents;
  const given = exportedNames(contents);
  const missing = [...exportedNames(fs.readFileSync(real, "utf8"))].filter(
    (name) => name !== "default" && !given.has(name),
  );
  if (missing.length === 0) return contents;
  const filler = missing.map(
    (name) =>
      `export function ${name}() { throw new Error(${JSON.stringify(`${specifier}: ${name} is not stubbed in this test`)}); }`,
  );
  return `${contents}\n// Not used by this test (scripts/run-store-stub-exports.cjs):\n${filler.join("\n")}\n`;
}

module.exports = { completeStubExports, exportedNames };
