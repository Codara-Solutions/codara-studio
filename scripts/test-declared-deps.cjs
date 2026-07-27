// Declared-dependency check for the main and preload bundles.
//
//   node scripts/test-declared-deps.cjs
//
// electron.vite.config.ts builds main and preload with externalizeDepsPlugin(),
// whose rule is exactly `Object.keys(pkg.dependencies)`: a package listed there
// stays an external `require("pkg")` and is resolved from node_modules at
// runtime; anything else is INLINED into out/main/chunks by rollup.
//
// Inlining is silently fine for a pure-JS package and fatal for one that
// resolves something relative to its own location. A native addon is the worst
// case: its resolver looks for the prebuilt .node next to the CHUNK, finds
// nothing, and the feature dies the first time a user touches it. That is not
// hypothetical. @hyperswarm/secret-stream and sodium-native were
// imported by src/main/remote-access/** while being reachable only transitively
// (through the declared but unused `hyperswarm`), so remote access threw
// "Cannot find addon '.'" on every attempt to turn it on, in dev and in the
// packaged app alike, while the script-based harness that marked those
// external by hand stayed green. See commit 732f18e.
//
// devDependencies do NOT satisfy this: they are not externalized (so they get
// inlined), and electron-builder ships only `dependencies` into the app.
//
// This check fails when a package imported at runtime by src/main/** or
// src/preload/** is missing from `dependencies`. The renderer is deliberately
// out of scope: it is bundled by vite with no externalization by design.

const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const ts = require(path.join(ROOT, "node_modules", "typescript"));

// The two bundles built with externalizeDepsPlugin().
const SCANNED = ["src/main", "src/preload"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
// Build-time path aliases, not packages (see electron.vite.config.ts).
const ALIAS_PREFIXES = ["@shared/", "@/", "@renderer/"];
// Supplied by the Electron runtime itself, never bundled or shipped.
const RUNTIME_PROVIDED = new Set(["electron"]);
const BUILTINS = new Set(builtinModules);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const dependencies = pkg.dependencies || {};
const devDependencies = pkg.devDependencies || {};

let failures = 0;
const check = (cond, msg) => {
  if (!cond) failures += 1;
  console.log((cond ? "PASS " : "FAIL ") + msg);
};

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    // .d.ts files are types only and never emit a runtime require.
    else if (SOURCE_EXT.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function packageName(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function isBarePackage(specifier) {
  if (!specifier) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:")) return false;
  if (ALIAS_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return false;
  const name = packageName(specifier);
  return !BUILTINS.has(name) && !RUNTIME_PROVIDED.has(name);
}

// A type-only import is erased before the bundler sees it, so it creates no
// runtime dependency. Covers `import type X`, `import { type A, type B }`, and
// leaves a bare `import "pkg"` (a side effect) counted as runtime.
function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

// package name -> [{ file, specifier, kind }]
const imported = new Map();
const record = (specifier, file, kind) => {
  const name = packageName(specifier);
  if (!imported.has(name)) imported.set(name, []);
  imported.get(name).push({ file: path.relative(ROOT, file), specifier, kind });
};

let scannedFiles = 0;
for (const relative of SCANNED) {
  for (const file of sourceFiles(path.join(ROOT, relative))) {
    scannedFiles += 1;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (isBarePackage(node.moduleSpecifier.text) && !isTypeOnlyImport(node)) {
          record(node.moduleSpecifier.text, file, "import");
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.isTypeOnly &&
        isBarePackage(node.moduleSpecifier.text)
      ) {
        record(node.moduleSpecifier.text, file, "export-from");
      } else if (ts.isCallExpression(node)) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument) || !isBarePackage(argument.text)) {
          ts.forEachChild(node, visit);
          return;
        }
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) record(argument.text, file, "dynamic import");
        else if (ts.isIdentifier(callee) && callee.text === "require") record(argument.text, file, "require");
        // require.resolve("pkg/...") needs the package present in node_modules
        // at runtime just as much as an import does, and electron-builder only
        // copies `dependencies` into the packaged app. A computed specifier
        // (template literal) is not analyzable here and is skipped on purpose.
        else if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "resolve" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "require"
        ) {
          record(argument.text, file, "require.resolve");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

// The premise of this whole check. If the build stops externalizing by
// `dependencies`, the rule enforced below is no longer the rule that matters.
const viteConfig = fs.readFileSync(path.join(ROOT, "electron.vite.config.ts"), "utf8");
check(
  (viteConfig.match(/externalizeDepsPlugin\(\)/g) || []).length >= 2,
  "main and preload are both built with externalizeDepsPlugin()",
);

console.log(`  info: scanned ${scannedFiles} files under ${SCANNED.join(", ")}`);
console.log(`  info: ${imported.size} distinct packages imported at runtime`);
check(imported.size > 0, `the scanned set is non-trivial (${imported.size} packages)`);

for (const [name, uses] of [...imported].sort()) {
  if (dependencies[name]) {
    check(true, `"${name}" is declared in dependencies`);
    continue;
  }
  const where = devDependencies[name]
    ? "it is in devDependencies, which is neither externalized nor shipped"
    : "it is declared nowhere, so it is reachable only transitively";
  check(
    false,
    `"${name}" is NOT in dependencies: ${where}. Imported by ${uses
      .map((use) => `${use.file} (${use.kind})`)
      .join(", ")}`,
  );
}

// Native addons are the entries that fail hard rather than degrade, so name
// them even when they pass.
const native = [...imported.keys()].filter((name) => {
  const dir = path.join(ROOT, "node_modules", name);
  if (fs.existsSync(path.join(dir, "prebuilds")) || fs.existsSync(path.join(dir, "binding.gyp"))) return true;
  const release = path.join(dir, "build", "Release");
  try {
    return fs.readdirSync(release).some((file) => file.endsWith(".node"));
  } catch {
    return false;
  }
});
console.log(`  info: native addons among them: ${native.join(", ") || "none"}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
