#!/usr/bin/env node
"use strict";

// Claude accounts in Codara's live slot (claude-cli-live-login.ts): every
// managed account runs with CLAUDE_CONFIG_DIR at <codaraHome>/claude-cli/
// live/home, a switch moves only the account-scoped keys and the
// `.claude.json` identity of that slot, and the user's own Claude home, the
// System login, is never read for secrets or written. The Keychain is off
// (CODARA_DISABLE_KEYCHAIN=1), so the slot's store is its `.credentials.json`;
// the Keychain rules themselves are covered by test-claude-cli-credentials.cjs.
//
//   node scripts/test-claude-cli-live-login.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-live-login-"));
const FAKE_HOME = path.join(TMP, "home");
process.env.CODARA_DISABLE_KEYCHAIN = "1";
process.env.HOME = FAKE_HOME;
process.env.CODARA_HOME_DIR = path.join(TMP, "codara");
delete process.env.CLAUDE_CONFIG_DIR;

const ROOT = path.resolve(__dirname, "..");
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function load() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "claude-cli-live-login.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

function login(name, expiresAt = 2_000_000_000_000) {
  return {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt,
    scopes: ["user:inference", "user:mcp_servers"],
    subscriptionType: "max",
  };
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fixture(name) {
  const rootDir = path.join(process.env.CODARA_HOME_DIR, name, "claude-cli");
  const liveConfigDir = path.join(rootDir, "live", "home");
  fs.mkdirSync(liveConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(rootDir, "accounts"), { recursive: true, mode: 0o700 });
  return {
    store: { rootDir, liveConfigDir },
    liveCredentials: path.join(liveConfigDir, ".credentials.json"),
    liveConfig: path.join(liveConfigDir, ".claude.json"),
    vault: (id) => path.join(rootDir, "accounts", id, "login.json"),
    marker: path.join(rootDir, "live-login.json"),
  };
}

function vaultLogin(f, id, record, oauthAccount) {
  writeJson(f.vault(id), {
    version: 1,
    store: { claudeAiOauth: record, ...(id === ACCOUNT_A ? { designOauth: { accessToken: "design-a" } } : {}) },
    ...(oauthAccount ? { oauthAccount } : {}),
  });
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

async function main() {
  // The user's own Claude home, which the System login uses. Nothing below
  // may change a byte of it.
  const ownClaude = path.join(FAKE_HOME, ".claude");
  writeJson(path.join(ownClaude, ".credentials.json"), { claudeAiOauth: login("system") });
  writeJson(path.join(FAKE_HOME, ".claude.json"), {
    oauthAccount: { accountUuid: "uuid-system", emailAddress: "me@example.com" },
    projects: { "/work": { hasTrustDialogAccepted: true } },
  });
  const ownBefore = snapshotTree(FAKE_HOME);

  const mod = await load();
  const f = fixture("switch");
  const knownProfileIds = async () => [ACCOUNT_A, ACCOUNT_B];
  const grant = { serverName: "posthog", accessToken: "grant", clientId: "c1" };
  writeJson(f.liveCredentials, { mcpOAuth: { "posthog|1": grant } });
  writeJson(f.liveConfig, { numStartups: 7, modelAccessCache: { stale: true }, projects: { "/w": {} } }, 0o644);
  vaultLogin(f, ACCOUNT_A, login("a1"), { accountUuid: "uuid-a", emailAddress: "a@example.com" });
  vaultLogin(f, ACCOUNT_B, login("b1"), { accountUuid: "uuid-b", emailAddress: "b@example.com" });

  // --- The first switch fills an empty slot --------------------------------
  assert.equal(await mod.readClaudeLiveProfileId(f.store.rootDir), null);
  assert.equal(await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds }), null);
  const liveA = readJson(f.liveCredentials);
  assert.deepEqual(liveA.claudeAiOauth, login("a1"));
  assert.deepEqual(liveA.designOauth, { accessToken: "design-a" });
  assert.deepEqual(liveA.mcpOAuth, { "posthog|1": grant }, "MCP grants never move on a switch");
  const configA = readJson(f.liveConfig);
  assert.equal(configA.oauthAccount.accountUuid, "uuid-a");
  assert.equal(configA.modelAccessCache, undefined, "account caches are cleared like a native /login");
  assert.equal(configA.numStartups, 7, "everything else in .claude.json stays");
  assert.deepEqual(readJson(f.marker), { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a" });
  assert.equal(await mod.claudeLiveSlotHoldsProfile(f.store, ACCOUNT_A), true);
  console.log("PASS the first switch fills the empty slot with the login and identity only");

  // --- The hot swap ---------------------------------------------------------
  // Claude Code refreshed A in the slot; switching away saves that
  // generation, not the stale vault copy.
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a2") });
  assert.equal(await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds }), ACCOUNT_A);
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a2"));
  const liveB = readJson(f.liveCredentials);
  assert.deepEqual(liveB.claudeAiOauth, login("b1"));
  assert.equal(liveB.designOauth, undefined, "A's design login left with A");
  assert.deepEqual(liveB.mcpOAuth, { "posthog|1": grant });
  assert.equal(readJson(f.liveConfig).oauthAccount.accountUuid, "uuid-b");
  assert.equal(await mod.readClaudeLiveProfileId(f.store.rootDir), ACCOUNT_B);

  // Re-selecting the live profile is a no-op.
  const before = fs.readFileSync(f.liveCredentials, "utf8");
  assert.equal(await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds }), ACCOUNT_B);
  assert.equal(fs.readFileSync(f.liveCredentials, "utf8"), before);

  // Choosing the System login moves nothing: running managed sessions keep
  // their account, and new terminals simply run without the slot.
  const markerBefore = fs.readFileSync(f.marker, "utf8");
  assert.equal(await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds }), ACCOUNT_B);
  assert.equal(fs.readFileSync(f.liveCredentials, "utf8"), before);
  assert.equal(fs.readFileSync(f.marker, "utf8"), markerBefore);
  console.log("PASS a switch saves the refreshed login and swaps the slot; the System login moves nothing");

  // --- Reads and writes through the slot -----------------------------------
  const readA = await mod.readClaudeProfileLogin(f.store, ACCOUNT_A);
  assert.equal(readA.kind, "login");
  assert.equal(readA.live, false);
  assert.equal(readA.record.accessToken, "access-a2");
  const readB = await mod.readClaudeProfileLogin(f.store, ACCOUNT_B);
  assert.equal(readB.live, true);
  assert.equal(readB.record.accessToken, "access-b1");
  assert.deepEqual(
    await mod.readClaudeProfileLogin(f.store, "personal"),
    { kind: "unreadable" },
    "the System login's secrets are never read",
  );
  await mod.writeClaudeProfileLogin(f.store, ACCOUNT_A, login("a3"));
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a3"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("b1"), "a vaulted write never touches the slot");
  await mod.writeClaudeProfileLogin(f.store, ACCOUNT_B, login("b2"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("b2"));
  assert.deepEqual(readJson(f.vault(ACCOUNT_B)).store.claudeAiOauth, login("b2"), "the vault copy trails the slot");
  await assert.rejects(() => mod.writeClaudeProfileLogin(f.store, "personal", login("x")), /managed/);
  await assert.rejects(() => mod.writeClaudeProfileIdentity(f.store, "personal", { accountUuid: "x" }), /managed/);
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  assert.deepEqual(await mod.readClaudeProfileIdentity(f.store, ACCOUNT_A), {
    fingerprint: sha("uuid-a"),
    email: "a@example.com",
  });
  assert.deepEqual(
    await mod.readClaudeSystemIdentity({ personalConfigDir: ownClaude, personalConfigDirEnv: null }),
    { fingerprint: sha("uuid-system"), email: "me@example.com" },
    "the System identity is read from the user's own .claude.json",
  );
  console.log("PASS a profile's login is the slot while live and its vault otherwise; the System login is never read or written");

  // --- A /login inside a managed terminal ----------------------------------
  // As a known account: the slot's login is saved into that account's vault.
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a-native") });
  writeJson(f.liveConfig, { ...readJson(f.liveConfig), oauthAccount: { accountUuid: "uuid-a" } }, 0o644);
  assert.equal(await mod.claudeLiveSlotHoldsProfile(f.store, ACCOUNT_B), false, "the slot no longer holds B's login");
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds });
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a-native"));
  assert.deepEqual(readJson(f.vault(ACCOUNT_B)).store.claudeAiOauth, login("b2"), "B's vault is not overwritten with A's login");
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("a-native"));

  // As an unknown account: kept aside, never saved into another account.
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("stranger") });
  writeJson(f.liveConfig, { ...readJson(f.liveConfig), oauthAccount: { accountUuid: "uuid-stranger" } }, 0o644);
  const logs = [];
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds, log: (message) => logs.push(message) });
  const strays = fs.readdirSync(f.store.rootDir).filter((name) => name.startsWith("stray-login-"));
  assert.equal(strays.length, 1, "an unattributable login is kept aside");
  assert.deepEqual(readJson(path.join(f.store.rootDir, strays[0])).store.claudeAiOauth, login("stranger"));
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a-native"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("b2"));
  assert.ok(logs.some((message) => message.includes("could not be attributed")));
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(f.store.rootDir, strays[0]), old, old);
  await mod.pruneClaudeStrayLogins(f.store.rootDir);
  assert.equal(fs.existsSync(path.join(f.store.rootDir, strays[0])), false, "a month-old stray login is removed");
  console.log("PASS a /login as a known account lands in its vault, and a stranger's login is kept aside");

  // --- A switch interrupted by a crash --------------------------------------
  // The marker journals the switch; the credential had not moved yet.
  writeJson(f.marker, { version: 1, profileId: ACCOUNT_B, accountUuid: "uuid-b", switchingFrom: ACCOUNT_A });
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a-native") });
  writeJson(f.liveConfig, { ...readJson(f.liveConfig), oauthAccount: { accountUuid: "uuid-a" } }, 0o644);
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds });
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a-native"), "the slot's login went back to its owner");
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("b2"));
  assert.deepEqual(readJson(f.marker), { version: 1, profileId: ACCOUNT_B, accountUuid: "uuid-b" });

  // The credential had moved, `.claude.json` had not.
  writeJson(f.marker, { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a", switchingFrom: ACCOUNT_B });
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a-native") });
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds });
  assert.deepEqual(readJson(f.vault(ACCOUNT_B)).store.claudeAiOauth, login("b2"), "B's vault was not overwritten with A's login");
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("a-native"));
  assert.equal(readJson(f.liveConfig).oauthAccount.accountUuid, "uuid-a");
  assert.equal(readJson(f.marker).switchingFrom, undefined);
  console.log("PASS an interrupted switch is finished without crossing logins");

  // --- Sign-outs, dead logins and a deleted account -------------------------
  // Claude Code blanked a login whose refresh token was spent: switching
  // away drops the trailing copy so the dead login cannot come back.
  writeJson(f.liveCredentials, {
    ...readJson(f.liveCredentials),
    claudeAiOauth: { ...login("dead"), accessToken: "", refreshToken: "", expiresAt: 0 },
  });
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds });
  const deadVault = readJson(f.vault(ACCOUNT_A));
  assert.deepEqual(deadVault.store, {}, "the dead login's trailing copy is dropped");
  assert.equal(deadVault.oauthAccount.accountUuid, "uuid-a", "the recorded account stays for display");
  await assert.rejects(
    () => mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds }),
    /not signed in/,
    "a signed-out profile takes the slot only with allowSignedOut",
  );

  // Clearing the live profile removes only its account keys.
  await mod.clearClaudeProfileLogin(f.store, ACCOUNT_B);
  const cleared = readJson(f.liveCredentials);
  assert.equal(cleared.claudeAiOauth, undefined);
  assert.deepEqual(cleared.mcpOAuth, { "posthog|1": grant }, "signing an account out keeps the MCP grants");
  assert.equal(fs.existsSync(f.vault(ACCOUNT_B)), false);

  // Deleting the account the slot holds empties the slot and drops the
  // marker, so no later switch can save the deleted login into a vault.
  await mod.writeClaudeProfileLogin(f.store, ACCOUNT_A, login("a4"));
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds, allowSignedOut: true });
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("a4"));
  assert.equal(await mod.releaseClaudeLiveSlot(f.store, ACCOUNT_B), false, "a slot holding another account is left alone");
  assert.equal(await mod.releaseClaudeLiveSlot(f.store, ACCOUNT_A), true);
  const released = readJson(f.liveCredentials);
  assert.equal(released.claudeAiOauth, undefined);
  assert.equal(released.designOauth, undefined);
  assert.deepEqual(released.mcpOAuth, { "posthog|1": grant });
  assert.equal(readJson(f.liveConfig).oauthAccount, undefined);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(await mod.readClaudeLiveProfileId(f.store.rootDir), null);
  console.log("PASS dead, signed-out and deleted logins never come back, and MCP grants outlive them");

  // --- Claude Code's config lock --------------------------------------------
  const lockfile = require("proper-lockfile");
  const release = await lockfile.lock(f.liveConfig, {
    realpath: false,
    lockfilePath: `${f.liveConfig}.lock`,
  });
  let updated = false;
  const pending = mod
    .updateClaudeGlobalConfig(mod.claudeLiveHome(f.store), (config) => ({ ...config, touched: true }))
    .then(() => {
      updated = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(updated, false, "Codara waits for Claude Code's own config write");
  writeJson(f.liveConfig, { ...readJson(f.liveConfig), writtenByClaude: true }, 0o644);
  await release();
  await pending;
  const finalConfig = readJson(f.liveConfig);
  assert.equal(finalConfig.touched, true);
  assert.equal(finalConfig.writtenByClaude, true, "the write Claude Code made under its lock survives");
  fs.writeFileSync(f.liveConfig, "{ not json");
  await assert.rejects(() =>
    mod.updateClaudeGlobalConfig(mod.claudeLiveHome(f.store), (config) => config),
  );
  assert.equal(fs.readFileSync(f.liveConfig, "utf8"), "{ not json", "an unparsable config is never replaced");
  console.log("PASS .claude.json changes wait for Claude Code's lock and re-read under it");

  // --- The user's own home ----------------------------------------------------
  // A config update aimed at the user's own home is refused before any lock
  // or temporary file is created there.
  await assert.rejects(
    () =>
      mod.updateClaudeGlobalConfig(
        { configDir: ownClaude, configDirEnv: null, homeDir: FAKE_HOME },
        (config) => ({ ...config, touched: true }),
      ),
    { name: "OutsideWriteError" },
  );
  assert.deepEqual(snapshotTree(FAKE_HOME), ownBefore, "the user's own Claude home is byte-for-byte unchanged");
  console.log("PASS the user's own Claude home is never written");

  console.log("\nPASS Claude accounts in Codara's live slot");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
