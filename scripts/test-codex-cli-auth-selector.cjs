#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const source = (name) =>
  path.join(ROOT, "src", "main", "orchestration", name);
const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function loadContract(entryPoint) {
  const output = await esbuild.build({
    entryPoints: [entryPoint],
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
  const T = await loadContract(source("codex-cli-auth-selector.ts"));
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
    await T.finalizeCodexCliLogout(store, PROFILE);
    assert.equal(fs.existsSync(live), false);
    assert.equal(fs.existsSync(managed), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // Sign-out followed by a fresh `codex login` in a terminal: the personal
  // backup is gone while the marker still names personal. The vault must
  // re-seed from the live login instead of failing every inspect.
  const reseedFixture = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-reseed-test-"));
  try {
    const store = {
      rootDir: path.join(reseedFixture, ".codarastudio", "codex-cli"),
      personalHomeDir: path.join(reseedFixture, ".codex"),
    };
    const live = path.join(store.personalHomeDir, "auth.json");
    const managed = path.join(store.rootDir, "accounts", PROFILE, "auth.json");
    writePrivate(T.codexCliPersonalAuthFile(store.rootDir), "OLD_PERSONAL");
    writePrivate(live, "OLD_PERSONAL");
    await T.activateCodexCliAccount(store, "personal");
    fs.rmSync(T.codexCliPersonalAuthFile(store.rootDir));
    writePrivate(live, "FRESH_LOGIN");
    assert.equal(await T.ensureCodexCliAuthVault(store), "personal");
    assert.equal(
      fs.readFileSync(T.codexCliPersonalAuthFile(store.rootDir), "utf8"),
      "FRESH_LOGIN",
      "a missing personal backup re-seeds from the live login",
    );
    // Signed out everywhere is a state, never an error.
    fs.rmSync(T.codexCliPersonalAuthFile(store.rootDir));
    fs.rmSync(live);
    assert.equal(await T.ensureCodexCliAuthVault(store), "personal");
    assert.equal(fs.existsSync(T.codexCliPersonalAuthFile(store.rootDir)), false);
    // A managed account owning the live slot is never mistaken for personal.
    writePrivate(live, "PERSONAL_AGAIN");
    writePrivate(managed, "MANAGED_SECRET_2");
    await T.activateCodexCliAccount(store, PROFILE);
    fs.rmSync(T.codexCliPersonalAuthFile(store.rootDir));
    assert.equal(await T.ensureCodexCliAuthVault(store), PROFILE);
    assert.equal(
      fs.existsSync(T.codexCliPersonalAuthFile(store.rootDir)),
      false,
      "the live managed credential must not be copied into the personal backup",
    );
    // Activating a signed-out slot is refused by default: the live login
    // stays where it is and the marker does not move.
    await assert.rejects(
      () => T.activateCodexCliAccount(store, "personal"),
      /not signed in/,
    );
    assert.equal(fs.readFileSync(live, "utf8"), "MANAGED_SECRET_2");
    assert.equal(await T.ensureCodexCliAuthVault(store), PROFILE);
    // The delete hand-off may activate a signed-out slot: the previous
    // login is saved to its vault, the live file goes, the marker moves.
    assert.equal(
      await T.activateCodexCliAccount(store, "personal", { allowSignedOut: true }),
      PROFILE,
    );
    assert.equal(fs.existsSync(live), false, "a signed-out slot leaves no live file");
    assert.equal(fs.readFileSync(managed, "utf8"), "MANAGED_SECRET_2", "the previous login is saved");
    assert.equal(await T.ensureCodexCliAuthVault(store), "personal");
    assert.equal(await T.readCodexCliSelection(store.rootDir), "personal");
    // The selection lock serializes a caller with a switch.
    const order = [];
    const held = T.withCodexSelectionLock(store.rootDir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push("lock");
    });
    const switching = T.activateCodexCliAccount(store, PROFILE).then(() => order.push("switch"));
    await Promise.all([held, switching]);
    assert.deepEqual(order, ["lock", "switch"]);
  } finally {
    fs.rmSync(reseedFixture, { recursive: true, force: true });
  }

  console.log("Codex auth-only selector contracts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
