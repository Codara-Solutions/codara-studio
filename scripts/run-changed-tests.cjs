#!/usr/bin/env node
"use strict";

// Inner-loop runner: only the unit suites that can see what changed.
//
//   npm run test:changed               against the merge base with origin/main
//   npm run test:changed -- <ref>      against the merge base with <ref>
//   npm run test:changed -- --list     print the selection, run nothing
//
// "Changed" is the diff from the merge base to the working tree, plus
// untracked files. A suite is selected when a changed file is reachable from
// it: through the files it names (a require, an esbuild entry built with
// path.join(ROOT, "src", ...), a source it reads as text), then through those
// files' own imports. Changing a dependency manifest or a TypeScript or Vite
// config selects everything. The selection errs toward running more; `npm
// test` stays the gate before landing.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listTests, runTests } = require("./run-all-tests.cjs");

const ROOT = path.resolve(__dirname, "..");
const CODE = /\.(ts|tsx|mts|cts|js|jsx|cjs|mjs)$/;
const EVERYTHING = /^(package\.json|package-lock\.json|\.nvmrc|tsconfig[^/]*\.json|electron\.vite\.config\.ts)$/;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function lines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function changedFiles(baseArg) {
  const candidates = baseArg ? [baseArg] : ["origin/main", "main"];
  let base = null;
  for (const ref of candidates) {
    try {
      base = git(["merge-base", "HEAD", ref]).trim();
      break;
    } catch {}
  }
  if (!base) throw new Error(`No merge base with ${candidates.join(" or ")}. Pass a ref: npm run test:changed -- <ref>`);
  return {
    base,
    files: [...new Set([...lines(git(["diff", "--name-only", base])), ...lines(git(["ls-files", "--others", "--exclude-standard"]))])],
  };
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g;
const HUB_IMPORTS = 30;
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*["'`][^"'`]+["'`]/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".cjs", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function resolveSpecifier(fromFile, spec, known) {
  let base;
  if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(fromFile), spec);
  else if (spec.startsWith("@shared/")) base = `src/shared/${spec.slice(8)}`;
  else if (spec.startsWith("@/")) base = `src/renderer/src/${spec.slice(2)}`;
  else return null;
  for (const ext of EXTENSIONS) {
    if (known.has(base + ext)) return base + ext;
  }
  // `./x.js` written for a `./x.ts` source.
  const stripped = base.replace(/\.(c|m)?js$/, "");
  for (const ext of EXTENSIONS) {
    if (known.has(stripped + ext)) return stripped + ext;
  }
  return null;
}

// Index every file by the names a suite might use for it: its path from the
// root, any trailing part of that path, with or without the extension, and
// its bare name when that name is distinctive.
function buildNameIndex(files) {
  const index = new Map();
  const add = (key, file) => {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(file);
  };
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 0; i < parts.length; i += 1) {
      const suffix = parts.slice(i).join("/");
      const isBare = i === parts.length - 1;
      add(suffix, file);
      const noExt = suffix.replace(/\.[^./]+$/, "");
      if (!isBare || noExt.length >= 8) add(noExt, file);
    }
  }
  // A bare name shared by many files ("index", "types.ts") says nothing.
  for (const [key, set] of index) {
    if (!key.includes("/") && set.size > 3) index.delete(key);
  }
  return index;
}

function mentionedFiles(text, index) {
  // path.join(ROOT, "src", "main", "x.ts") names src/main/x.ts.
  const joined = text.replace(/["'`]\s*,\s*["'`]/g, "/");
  const found = new Set();
  for (const raw of joined.match(/[A-Za-z0-9_@.\-/]{4,}/g) ?? []) {
    let token = raw.replace(/^(\.{1,2}\/)+/, "").replace(/^\/+/, "");
    if (token.startsWith("@shared/")) token = `src/shared/${token.slice(8)}`;
    else if (token.startsWith("@/")) token = `src/renderer/src/${token.slice(2)}`;
    for (const file of index.get(token) ?? []) found.add(file);
  }
  return found;
}

function selectTests(changed) {
  const tracked = lines(git(["ls-files"]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  const all = [...new Set([...tracked, ...untracked, ...changed])].filter((f) => !f.startsWith("node_modules/"));
  const known = new Set(all.filter((f) => fs.existsSync(path.join(ROOT, f))));
  const index = buildNameIndex(all);
  const tests = new Set(listTests().map((f) => `scripts/${f}`));

  // importers.get(x) = files that import x; readers.get(x) = suites and
  // script helpers that name x (to bundle it, or to read it as text).
  const importers = new Map();
  const readers = new Map();
  const importCount = new Map();
  const edge = (graph, user, used) => {
    if (user === used) return;
    if (!graph.has(used)) graph.set(used, new Set());
    graph.get(used).add(user);
  };
  for (const file of known) {
    if (!CODE.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    // Type-only imports vanish from the bundles the suites run.
    const runtime = text.replace(TYPE_ONLY, "");
    for (const m of runtime.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, m[1], known);
      if (target) {
        edge(importers, file, target);
        importCount.set(file, (importCount.get(file) ?? 0) + 1);
      }
    }
    // Suites and script helpers also name files they bundle or read.
    if (file.startsWith("scripts/")) {
      for (const target of mentionedFiles(text, index)) edge(readers, file, target);
    }
  }

  const selected = new Set();
  const changedSet = new Set(changed);
  const seen = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const file = queue.shift();
    if (tests.has(file)) selected.add(file.slice("scripts/".length));
    // Suites read the app's wiring files (src/main/index.ts, ipc.ts, App.tsx)
    // as text to check one registration. They import most of the app, so
    // following that link would select a suite for almost any change; such
    // a suite is selected only when the wiring file itself changed.
    const hub = (importCount.get(file) ?? 0) >= HUB_IMPORTS && !changedSet.has(file);
    const users = [...(importers.get(file) ?? []), ...(hub ? [] : (readers.get(file) ?? []))];
    for (const user of users) {
      if (seen.has(user)) continue;
      seen.add(user);
      queue.push(user);
    }
  }
  return [...selected].sort();
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const baseArg = args.find((a) => !a.startsWith("--")) ?? process.env.CODARA_TEST_BASE ?? null;
  const { base, files } = changedFiles(baseArg);
  const everything = files.filter((f) => EVERYTHING.test(f));
  const tests = everything.length > 0 ? listTests() : selectTests(files);
  console.log(
    `${files.length} changed file(s) since ${base.slice(0, 10)}` +
      (everything.length > 0 ? ` (including ${everything.join(", ")}, so every suite runs)` : "") +
      `: ${tests.length} suite(s) selected.`,
  );
  if (listOnly) {
    for (const t of tests) console.log(t);
    return 0;
  }
  if (tests.length === 0) return 0;
  console.log("");
  const failed = await runTests(tests);
  return failed.length > 0 ? 1 : 0;
}

module.exports = { selectTests };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error?.message ?? error);
      process.exit(1);
    },
  );
}
