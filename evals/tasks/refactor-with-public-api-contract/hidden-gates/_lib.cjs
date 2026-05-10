// Shared helpers for hidden gates.
//
// Hidden gates need to find the agent's new helpers without knowing where
// the agent put them. The plan asks for `quoteForShell(arg, family)` and a
// path-normalization helper, but the agent picks the filename. So we
// (a) walk a small set of likely locations, and
// (b) match by export name first, source-text grep second.
//
// We compile TS sources via the TypeScript compiler the project already
// has installed as a devDependency (no extra installs).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { execSync } = require("node:child_process");

const MAIN_DIR_CANDIDATES = [
  "src/main",
  "src/main/orchestration",
  "src/main/lib",
  "src/main/utils",
  "src/main/shells",
  "src/main/worker-launch",
];

let _ts = null;
function loadTypeScript(repoRoot) {
  if (_ts) return _ts;
  // Use the agent's own typescript install.
  const tsPath = require.resolve("typescript", { paths: [repoRoot] });
  _ts = require(tsPath);
  return _ts;
}

function listMainTs(repoRoot) {
  const out = [];
  for (const rel of MAIN_DIR_CANDIDATES) {
    const dir = path.join(repoRoot, rel);
    if (!fs.existsSync(dir)) continue;
    walk(dir, out);
  }
  return out;
}

function walk(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p, acc);
    } else if (ent.isFile() && /\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
      acc.push(p);
    }
  }
}

/**
 * Compile a single TS file (with module=commonjs, target=es2022) and load it
 * via Node's CommonJS module system. Returns the module.exports.
 *
 * The agent's source uses ESM syntax + the @shared/types path alias, but our
 * TS-to-JS pass with module=commonjs handles `import ... from "..."` fine,
 * and we resolve @shared/types via a small require hook.
 */
function compileAndLoad(repoRoot, tsFile) {
  const ts = loadTypeScript(repoRoot);
  const source = fs.readFileSync(tsFile, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      sourceMap: false,
      isolatedModules: true,
      allowJs: false,
    },
    fileName: tsFile,
    reportDiagnostics: false,
  });
  // We compile and load the module; if it imports another local file, Node's
  // require() will fail because that target is also TS. Hidden gates target
  // small leaf utility modules, which usually don't have transitive deps.
  // For deeper modules we fall back to source-text checks.
  const mod = new Module(tsFile, module);
  mod.filename = tsFile;
  mod.paths = Module._nodeModulePaths(path.dirname(tsFile));
  // Resolve @shared/types to a stub so the type-only import doesn't blow up.
  const origResolve = Module._resolveFilename;
  const sharedStubPath = path.join(__dirname, "_shared-types-stub.cjs");
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === "@shared/types") return sharedStubPath;
    return origResolve.call(this, request, parent, ...rest);
  };
  try {
    mod._compile(compiled.outputText, tsFile);
  } finally {
    Module._resolveFilename = origResolve;
  }
  return mod.exports;
}

/**
 * Find a module that exports a function matching `predicate(name, fn)`.
 * Returns { file, exportName, fn } or null.
 */
function findExportedFunction(repoRoot, predicate) {
  const files = listMainTs(repoRoot);
  for (const file of files) {
    let exports;
    try {
      exports = compileAndLoad(repoRoot, file);
    } catch {
      continue;
    }
    if (!exports || typeof exports !== "object") continue;
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value === "function" && predicate(name, value, file)) {
        return { file, exportName: name, fn: value };
      }
    }
  }
  return null;
}

/**
 * Find a module that exports something matching `predicate(exportName, value, file)`.
 */
function findExport(repoRoot, predicate) {
  const files = listMainTs(repoRoot);
  for (const file of files) {
    let exports;
    try {
      exports = compileAndLoad(repoRoot, file);
    } catch {
      continue;
    }
    if (!exports || typeof exports !== "object") continue;
    for (const [name, value] of Object.entries(exports)) {
      if (predicate(name, value, file)) {
        return { file, exportName: name, value };
      }
    }
  }
  return null;
}

/**
 * Source-text grep over the main/ tree. Returns matching files. Useful when
 * the agent put a helper as a non-exported function inside an existing file.
 */
function grepMainSources(repoRoot, regex) {
  const files = listMainTs(repoRoot);
  const matches = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (regex.test(text)) matches.push({ file, text });
  }
  return matches;
}

module.exports = {
  loadTypeScript,
  listMainTs,
  compileAndLoad,
  findExportedFunction,
  findExport,
  grepMainSources,
};
