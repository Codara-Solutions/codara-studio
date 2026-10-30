#!/usr/bin/env node
"use strict";

// The renderer's Vite cache belongs to one checkout (electron.vite.config.ts).
// A worktree often links node_modules to the main checkout's. Vite's default
// cache is inside node_modules, and its config hash includes the project root,
// so a run in that worktree would find the other checkout's cache, see a
// mismatch and delete deps/ under the running app, which then fails with
// "Failed to fetch dynamically imported module".
//
// Here a second checkout, whose node_modules is a symlink to this one's and
// whose path has a space like the real Codara folder, must resolve a cache of
// its own, through electron-vite's real config loading.
//
// The cache then sits in the repository root, out of reach of the
// node_modules skip, so Ctrl+P's file list must leave it out by name.
//
//   node scripts/test-vite-cache-per-checkout.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.env.VITE_CJS_IGNORE_WARNING = "1";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara vite cache "));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(to, from)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), path.join(to, from));
}

async function rendererCacheDir(checkout) {
  const { resolveConfig } = await import("electron-vite");
  const resolved = await resolveConfig({ root: checkout, logLevel: "silent" }, "serve", "development");
  return resolved.config.renderer.cacheDir;
}

async function main() {
  const second = path.join(TMP, "second checkout");
  for (const file of ["electron.vite.config.ts", "package.json", "src/main/studio-csp.ts"]) copy(file, second);
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(second, "node_modules"));
  assert.equal(
    fs.realpathSync(path.join(second, "node_modules")),
    fs.realpathSync(path.join(ROOT, "node_modules")),
    "the two checkouts share node_modules",
  );

  assert.equal(await rendererCacheDir(second), path.join(second, ".vite-cache"));
  assert.equal(await rendererCacheDir(ROOT), path.join(ROOT, ".vite-cache"));

  execFileSync("git", ["check-ignore", "-q", ".vite-cache/deps/_metadata.json"], { cwd: ROOT, stdio: "ignore" });

  const fsTreeBundle = path.join(TMP, "fs-tree.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "src/main/fs-tree.ts")],
    outfile: fsTreeBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    external: ["electron"],
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  fs.mkdirSync(path.join(second, ".vite-cache", "deps"), { recursive: true });
  fs.writeFileSync(path.join(second, ".vite-cache", "deps", "react.js"), "");
  const { files } = await require(fsTreeBundle).listFiles(second);
  assert.ok(files.some((file) => file.name === "package.json"), "the checkout is listed");
  assert.deepEqual(files.filter((file) => file.path.includes(".vite-cache")), []);

  console.log("all vite cache checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
