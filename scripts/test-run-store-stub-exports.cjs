#!/usr/bin/env node
"use strict";

// Guard for the run-store test harnesses (scripts/run-store-stub-exports.cjs):
//   1. a stub that misses an export of the real module still builds, and the
//      missing export throws only when it is called;
//   2. every harness that bundles run-store.ts with a "stub" namespace passes
//      its stubs through completeStubExports, so one more import in
//      run-store.ts cannot break a neighbour's test at build time.
//
//   node scripts/test-run-store-stub-exports.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { completeStubExports, exportedNames } = require("./run-store-stub-exports.cjs");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${String(error && error.message).split("\n")[0]}`);
  }
}

async function main() {
  await check("export names are read from declarations and export lists, types left out", () => {
    const names = exportedNames([
      "export async function a() {}",
      "export const b = 1;",
      "export class C {}",
      "export type T = string;",
      "export interface I {}",
      "export { d, e as f, type G };",
      "export default {};",
    ].join("\n"));
    assert.deepEqual([...names].sort(), ["C", "a", "b", "d", "default", "f"]);
  });

  await check("a stub missing exports of the real module builds, and a missing export throws only when called", async () => {
    const stub = "export async function resolveCodaraPiExecutionAccount() { return null; }";
    const completed = completeStubExports("./pi-runtime-electron", stub);
    const real = exportedNames(fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "pi-runtime-electron.ts"), "utf8"));
    for (const name of real) {
      if (name !== "default") assert.ok(exportedNames(completed).has(name), `${name} is missing`);
    }
    const result = await esbuild.build({
      stdin: {
        contents: `import { resolveCodaraPiExecutionAccount, listCodaraPiSkillNames } from "./pi-runtime-electron";\nmodule.exports = { resolveCodaraPiExecutionAccount, listCodaraPiSkillNames };`,
        resolveDir: ROOT,
        loader: "js",
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [{
        name: "stub",
        setup(build) {
          build.onResolve({ filter: /^\.\/pi-runtime-electron$/ }, (args) => ({ path: args.path, namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: completed, loader: "js" }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
    assert.equal(await mod.exports.resolveCodaraPiExecutionAccount(), null);
    assert.throws(() => mod.exports.listCodaraPiSkillNames(), /listCodaraPiSkillNames is not stubbed in this test/);
  });

  await check("package stubs and CommonJS stubs are left as they are", () => {
    assert.equal(completeStubExports("electron", "export const app = {};"), "export const app = {};");
    assert.equal(completeStubExports("./pi-runtime-electron", "module.exports = {};"), "module.exports = {};");
  });

  await check("every run-store harness with stubbed imports completes them", () => {
    const harnesses = fs
      .readdirSync(__dirname)
      .filter((name) => /^test-.*\.cjs$/.test(name) && name !== path.basename(__filename))
      .filter((name) => {
        const text = fs.readFileSync(path.join(__dirname, name), "utf8");
        // Stubs for run-store's own modules ("./backend-registry": ...),
        // not only for packages such as electron.
        return /run-store\.ts/.test(text) &&
          /namespace: "stub" \}, \(args\) => \(\{\s*contents:/.test(text) &&
          /["']\.\/[\w-]+["']\s*:/.test(text);
      });
    assert.ok(harnesses.length >= 10, `only ${harnesses.length} harnesses found`);
    const unguarded = harnesses.filter((name) => {
      const text = fs.readFileSync(path.join(__dirname, name), "utf8");
      return !/namespace: "stub" \}, \(args\) => \(\{\s*contents: completeStubExports\(args\.path, /.test(text);
    });
    assert.deepEqual(unguarded, [], `not guarded: ${unguarded.join(", ")}`);
  });

  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("run-store stub exports: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
