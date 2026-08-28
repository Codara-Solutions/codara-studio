#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "main", "orchestration", "codex-cli-auth-selector.ts");
const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function loadContract() {
  const output = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

async function main() {
  const T = await loadContract();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-auth-test-"));
  try {
    const store = {
      rootDir: path.join(fixture, ".codarastudio", "codex-cli"),
      personalHomeDir: path.join(fixture, ".codex"),
    };
    const live = path.join(store.personalHomeDir, "auth.json");
    const managed = path.join(store.rootDir, "accounts", PROFILE, "auth.json");
    writePrivate(live, "PERSONAL_SECRET");
    writePrivate(managed, "MANAGED_SECRET");
    const sharedState = path.join(store.personalHomeDir, "state_5.sqlite");
    const legacySplitState = path.join(
      store.rootDir,
      "accounts",
      PROFILE,
      "state_5.sqlite",
    );
    writePrivate(sharedState, "SHARED_SESSION_INDEX");
    writePrivate(legacySplitState, "LEGACY_SPLIT_INDEX");

    assert.equal(await T.ensureCodexCliAuthVault(store), "personal");
    assert.equal(
      fs.readFileSync(T.codexCliPersonalAuthFile(store.rootDir), "utf8"),
      "PERSONAL_SECRET",
      "migration preserves the historical ~/.codex login",
    );

    assert.equal(await T.activateCodexCliAccount(store, PROFILE), "personal");
    assert.equal(fs.readFileSync(live, "utf8"), "MANAGED_SECRET");
    assert.equal(fs.statSync(live).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(sharedState, "utf8"),
      "SHARED_SESSION_INDEX",
      "account switching never replaces the shared session database",
    );
    assert.equal(
      fs.readFileSync(legacySplitState, "utf8"),
      "LEGACY_SPLIT_INDEX",
      "legacy account databases are never activated or copied over shared state",
    );

    // Simulate Codex refreshing its live token, then switch back. The refresh
    // must be saved into only that account's vault slot.
    writePrivate(live, "MANAGED_REFRESHED");
    assert.equal(await T.activateCodexCliAccount(store, "personal"), PROFILE);
    assert.equal(fs.readFileSync(managed, "utf8"), "MANAGED_REFRESHED");
    assert.equal(fs.readFileSync(live, "utf8"), "PERSONAL_SECRET");

    const zshrc = path.join(fixture, ".zshrc");
    fs.writeFileSync(zshrc, "alias ll='ls -la'\n");
    const inheritedCodexHome = process.env.CODEX_HOME;
    await T.activateCodexCliAccount(store, PROFILE);
    assert.equal(
      fs.readFileSync(zshrc, "utf8"),
      "alias ll='ls -la'\n",
      "auth switching never edits shell startup files",
    );
    assert.equal(
      process.env.CODEX_HOME,
      inheritedCodexHome,
      "selector never mutates process env",
    );
    console.log("Codex CLI auth-only selector contracts passed");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
