#!/usr/bin/env node
"use strict";

// A restored Codex pane names the account it started on. When that account
// was deleted (and its directory purged) in the meantime, the pane must fall
// back to the default account without provisioning the deleted account's
// home again: nothing ever deletes an orphaned account directory.
//
// SAFETY: HOME, CODEX_HOME and CODARA_HOME_DIR all point into a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-native-codex-runtime-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
const SYSTEM_CODEX = path.join(HOME, ".codex");
fs.mkdirSync(SYSTEM_CODEX, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(SYSTEM_CODEX, "config.toml"), 'model = "gpt-6"\n', { mode: 0o600 });
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODEX_HOME = SYSTEM_CODEX;
for (const key of ["SPARK_HOME_DIR", "SPARK_USER_DATA_DIR"]) delete process.env[key];

async function bundle() {
  const outfile = path.join(TMP, "runtime.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "native-codex-profile-runtime.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "electron-stub",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(TMP)} };`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

async function main() {
  const runtime = await bundle();
  const store = runtime.nativeCodexProfileStore;
  const accountDir = (id) => path.join(store.rootDir, "accounts", id);

  const { profile } = await store.createProfile({ label: "Work" });
  const live = await runtime.resolveFrozenNativeCodexProfile(profile.id, {});
  assert.equal(live.profileId, profile.id, "a pane on a listed account keeps it");
  assert.ok(fs.existsSync(path.join(accountDir(profile.id), "home")), "a listed account's home is provisioned");
  console.log("PASS a restored pane keeps an account the store still lists");

  await store.deleteProfile(profile.id);
  assert.equal(fs.existsSync(accountDir(profile.id)), false);
  const fallback = await runtime.resolveFrozenNativeCodexProfile(profile.id, {});
  assert.equal(fallback.profileId, "personal", "a deleted account falls back to the default");
  assert.equal(fs.existsSync(accountDir(profile.id)), false, "the deleted account's home was recreated");
  console.log("PASS a restored pane of a deleted account falls back without recreating its home");

  const never = "0b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
  const unknown = await runtime.resolveFrozenNativeCodexProfile(never, {});
  assert.equal(unknown.profileId, "personal");
  assert.equal(fs.existsSync(accountDir(never)), false, "an unknown id got a home");
  console.log("PASS an id the store never listed gets no home");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
