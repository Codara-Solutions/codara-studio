#!/usr/bin/env node
"use strict";

// Claude accounts in one home (claude-cli-live-login.ts): every account runs
// in the user's own Claude home, a switch moves only the account-scoped keys
// and the `.claude.json` identity, and the per-directory model migrates into
// it without losing a login, an MCP grant or a project. The Keychain is off
// (CODARA_DISABLE_KEYCHAIN=1), so the live slot is the home's
// `.credentials.json`; the Keychain rules themselves are covered by
// test-claude-cli-credentials.cjs.
//
//   node scripts/test-claude-cli-live-login.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-live-login-"));
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
  const base = path.join(TMP, name);
  const home = path.join(base, "home");
  const store = {
    rootDir: path.join(base, "codara", "claude-cli"),
    personalConfigDir: path.join(home, ".claude"),
    personalConfigDirEnv: null,
  };
  fs.mkdirSync(store.personalConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(store.rootDir, "accounts"), { recursive: true, mode: 0o700 });
  return {
    store,
    liveCredentials: path.join(store.personalConfigDir, ".credentials.json"),
    liveConfig: path.join(home, ".claude.json"),
    accountDir: (id) => path.join(store.rootDir, "accounts", id),
    vault: (id) =>
      id === "personal"
        ? path.join(store.rootDir, "personal-login.json")
        : path.join(store.rootDir, "accounts", id, "login.json"),
    marker: path.join(store.rootDir, "live-login.json"),
  };
}

async function main() {
  const mod = await load();

  // --- Migration from one CLAUDE_CONFIG_DIR per account --------------------
  const f = fixture("migrate");
  const staleGrant = { serverName: "posthog", accessToken: "stale", clientId: "c1" };
  const freshGrant = {
    serverName: "posthog",
    accessToken: "fresh",
    refreshToken: "fresh-refresh",
    expiresAt: 3_000,
    clientId: "c2",
  };
  writeJson(f.liveCredentials, {
    claudeAiOauth: login("personal"),
    mcpOAuth: { "posthog|1": staleGrant, "only-live|2": { accessToken: "live-only" } },
  });
  writeJson(
    f.liveConfig,
    {
      oauthAccount: { accountUuid: "UUID-PERSONAL", emailAddress: "me@example.com" },
      projects: { "/work/personal": { hasTrustDialogAccepted: true } },
      mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } },
      modelAccessCache: { stale: true },
      numStartups: 42,
    },
    0o644,
  );
  fs.writeFileSync(path.join(f.store.personalConfigDir, "keybindings.json"), '{"old":true}\n');
  const old = new Date(Date.now() - 100_000);
  fs.utimesSync(path.join(f.store.personalConfigDir, "keybindings.json"), old, old);

  const legacyA = f.accountDir(ACCOUNT_A);
  writeJson(path.join(legacyA, ".credentials.json"), {
    claudeAiOauth: login("a1"),
    designOauth: { accessToken: "design-a" },
    mcpOAuth: { "posthog|1": freshGrant, "only-a|3": { accessToken: "a-only" } },
  });
  writeJson(path.join(legacyA, ".claude.json"), {
    oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@example.com" },
    projects: {
      "/work/personal": { hasTrustDialogAccepted: false },
      "/work/codara": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
    },
    mcpServers: { "codara-only": { type: "stdio", command: "x" } },
  });
  fs.writeFileSync(path.join(legacyA, "keybindings.json"), '{"codara":true}\n');
  // A registered profile with no login and an orphan directory are left alone.
  fs.mkdirSync(f.accountDir(ACCOUNT_B), { recursive: true, mode: 0o700 });

  const logs = [];
  const migrated = await mod.migrateClaudeToOneHome({
    store: f.store,
    managedProfileIds: [ACCOUNT_A, ACCOUNT_B],
    defaultProfileId: ACCOUNT_A,
    log: (message) => logs.push(message),
  });
  assert.equal(migrated.createdMarker, true);
  assert.deepEqual(migrated.vaulted, [ACCOUNT_A]);
  assert.deepEqual(migrated.retired, [ACCOUNT_A]);
  assert.equal(migrated.projects, 1, "only the project the live file lacked is carried over");
  assert.deepEqual(readJson(f.marker), {
    version: 1,
    profileId: "personal",
    accountUuid: "uuid-personal",
  });
  const vaultA = readJson(f.vault(ACCOUNT_A));
  assert.deepEqual(vaultA.store, {
    claudeAiOauth: login("a1"),
    designOauth: { accessToken: "design-a" },
  });
  assert.equal(vaultA.oauthAccount.accountUuid, "uuid-a");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.vault(ACCOUNT_A)).mode & 0o777, 0o600);
  }
  const liveAfterMigration = readJson(f.liveCredentials);
  assert.deepEqual(liveAfterMigration.claudeAiOauth, login("personal"), "the live login stays");
  assert.equal(liveAfterMigration.designOauth, undefined, "account keys never join the shared store");
  assert.deepEqual(liveAfterMigration.mcpOAuth, {
    "posthog|1": freshGrant,
    "only-live|2": { accessToken: "live-only" },
    "only-a|3": { accessToken: "a-only" },
  }, "the healthier grant wins per server and every server survives");
  assert.equal(fs.existsSync(path.join(legacyA, ".credentials.json")), false, "the account directory's store is retired");
  const configAfterMigration = readJson(f.liveConfig);
  assert.deepEqual(configAfterMigration.projects["/work/personal"], { hasTrustDialogAccepted: true });
  assert.deepEqual(configAfterMigration.projects["/work/codara"], {
    hasTrustDialogAccepted: true,
    allowedTools: ["Bash"],
  });
  assert.ok(configAfterMigration.mcpServers["codara-only"], "a server only a Codara account had is kept");
  assert.equal(configAfterMigration.numStartups, 42);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.liveConfig).mode & 0o777, 0o644, "Claude Code's config keeps its mode");
  }
  assert.equal(
    fs.readFileSync(path.join(f.store.personalConfigDir, "keybindings.json"), "utf8"),
    '{"codara":true}\n',
    "the newer keybindings from the Codara account win",
  );
  assert.equal(
    fs.readdirSync(f.store.personalConfigDir).filter((name) => name.startsWith("keybindings.json.codara-backup-")).length,
    1,
    "the replaced keybindings are kept",
  );
  assert.equal(fs.existsSync(f.vault(ACCOUNT_B)), false, "a profile without a login gets no vault");

  const again = await mod.migrateClaudeToOneHome({
    store: f.store,
    managedProfileIds: [ACCOUNT_A, ACCOUNT_B],
    defaultProfileId: ACCOUNT_A,
  });
  assert.equal(again.createdMarker, false);
  assert.deepEqual(again.vaulted, []);
  assert.equal(again.mcpGrants, 0);
  assert.equal(again.projects, 0);
  assert.deepEqual(readJson(f.liveCredentials), liveAfterMigration, "a second pass changes nothing");
  console.log("PASS migration: logins become vaults, MCP grants and projects join the home, and it is idempotent");

  // --- Switching -----------------------------------------------------------
  const knownProfileIds = async () => ["personal", ACCOUNT_A, ACCOUNT_B];
  const previous = await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds });
  assert.equal(previous, "personal");
  const liveA = readJson(f.liveCredentials);
  assert.deepEqual(liveA.claudeAiOauth, login("a1"));
  assert.deepEqual(liveA.designOauth, { accessToken: "design-a" });
  assert.deepEqual(liveA.mcpOAuth, liveAfterMigration.mcpOAuth, "MCP grants never move on a switch");
  const configA = readJson(f.liveConfig);
  assert.equal(configA.oauthAccount.accountUuid, "uuid-a");
  assert.equal(configA.modelAccessCache, undefined, "account caches are cleared like a native /login");
  assert.equal(configA.numStartups, 42, "everything else in .claude.json stays");
  assert.deepEqual(readJson(f.marker), { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a" });
  const personalVault = readJson(f.vault("personal"));
  assert.deepEqual(personalVault.store, { claudeAiOauth: login("personal") });
  assert.equal(personalVault.oauthAccount.accountUuid, "UUID-PERSONAL");
  assert.equal(await mod.readClaudeLiveProfileId(f.store.rootDir), ACCOUNT_A);
  console.log("PASS a switch moves only the login and identity; MCP grants and settings stay");

  // Claude Code refreshed A in the live slot; switching away saves that
  // generation, not the stale vault copy.
  const refreshedA = login("a2");
  const liveNow = readJson(f.liveCredentials);
  writeJson(f.liveCredentials, { ...liveNow, claudeAiOauth: refreshedA });
  await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds });
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, refreshedA);
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("personal"));
  assert.equal(readJson(f.liveConfig).oauthAccount.accountUuid, "UUID-PERSONAL");
  assert.equal(readJson(f.liveCredentials).designOauth, undefined, "A's design login left with A");

  // Re-selecting the live profile is a no-op.
  const before = fs.readFileSync(f.liveCredentials, "utf8");
  assert.equal(await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds }), "personal");
  assert.equal(fs.readFileSync(f.liveCredentials, "utf8"), before);
  console.log("PASS switching back saves the refreshed login; re-selecting is a no-op");

  // --- Reads and writes through the slot -----------------------------------
  const readA = await mod.readClaudeProfileLogin(f.store, ACCOUNT_A);
  assert.equal(readA.kind, "login");
  assert.equal(readA.live, false);
  assert.equal(readA.record.accessToken, "access-a2");
  const readPersonal = await mod.readClaudeProfileLogin(f.store, "personal");
  assert.equal(readPersonal.live, true);
  assert.equal(readPersonal.record.accessToken, "access-personal");
  await mod.writeClaudeProfileLogin(f.store, ACCOUNT_A, login("a3"));
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a3"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("personal"), "a vaulted write never touches the live slot");
  await mod.writeClaudeProfileLogin(f.store, "personal", login("personal2"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("personal2"));
  assert.deepEqual(readJson(f.vault("personal")).store.claudeAiOauth, login("personal2"), "the vault copy trails the live slot");
  assert.deepEqual(
    await mod.readClaudeProfileIdentity(f.store, ACCOUNT_A),
    { fingerprint: require("node:crypto").createHash("sha256").update("uuid-a").digest("hex"), email: "a@example.com" },
  );
  console.log("PASS a profile's slot is the live store while live and its vault otherwise");

  // --- A /login in another terminal ----------------------------------------
  // As a known account: the live login is saved into that account's vault.
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a-native") });
  const configNative = readJson(f.liveConfig);
  writeJson(f.liveConfig, { ...configNative, oauthAccount: { accountUuid: "uuid-a" } }, 0o644);
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds, allowSignedOut: true });
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a-native"), "a native /login as A lands in A's vault");
  assert.deepEqual(readJson(f.vault("personal")).store.claudeAiOauth, login("personal2"), "personal's vault is not overwritten with A's login");
  // B had no login: the live slot keeps no login, MCP grants stay.
  const liveB = readJson(f.liveCredentials);
  assert.equal(liveB.claudeAiOauth, undefined);
  assert.ok(liveB.mcpOAuth["posthog|1"], "MCP grants survive a signed-out switch");
  assert.equal(readJson(f.liveConfig).oauthAccount, undefined);
  await assert.rejects(
    () => mod.activateClaudeCliAccount(f.store, ACCOUNT_B, { knownProfileIds }),
    /not signed in/,
    "re-selecting a signed-out profile without allowSignedOut is refused",
  );

  // As an unknown account: kept aside, never saved into another account.
  await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds });
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("stranger") });
  writeJson(f.liveConfig, { ...readJson(f.liveConfig), oauthAccount: { accountUuid: "uuid-stranger" } }, 0o644);
  const strayLogs = [];
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, {
    knownProfileIds,
    log: (message) => strayLogs.push(message),
  });
  const strays = fs.readdirSync(f.store.rootDir).filter((name) => name.startsWith("stray-login-"));
  assert.equal(strays.length, 1, "an unattributable login is kept aside");
  assert.deepEqual(readJson(path.join(f.store.rootDir, strays[0])).store.claudeAiOauth, login("stranger"));
  assert.deepEqual(readJson(f.vault("personal")).store.claudeAiOauth, login("personal2"));
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("a-native"));
  assert.ok(strayLogs.some((message) => message.includes("could not be attributed")));
  console.log("PASS a native /login is saved to its own account, and a stranger's login is kept aside");

  // --- A switch interrupted by a crash --------------------------------------
  // The marker journals the switch; the credential had not moved yet.
  writeJson(f.marker, { version: 1, profileId: "personal", accountUuid: "uuid-personal", switchingFrom: ACCOUNT_A });
  await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds });
  assert.deepEqual(readJson(f.vault(ACCOUNT_A)).store.claudeAiOauth, login("a-native"), "the live login went back to its owner");
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("personal2"));
  assert.deepEqual(readJson(f.marker), { version: 1, profileId: "personal", accountUuid: "uuid-personal" });

  // The credential had moved, `.claude.json` had not.
  writeJson(f.marker, { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a", switchingFrom: "personal" });
  writeJson(f.liveCredentials, { ...readJson(f.liveCredentials), claudeAiOauth: login("a-native") });
  await mod.activateClaudeCliAccount(f.store, ACCOUNT_A, { knownProfileIds });
  assert.deepEqual(readJson(f.vault("personal")).store.claudeAiOauth, login("personal2"), "personal's vault was not overwritten with A's login");
  assert.deepEqual(readJson(f.liveCredentials).claudeAiOauth, login("a-native"));
  assert.equal(readJson(f.liveConfig).oauthAccount.accountUuid, "uuid-a");
  assert.equal(readJson(f.marker).switchingFrom, undefined);
  console.log("PASS an interrupted switch is finished without crossing logins");

  // --- Sign-outs and dead logins -------------------------------------------
  // Claude Code blanked a login whose refresh token was spent: switching
  // away drops the trailing copy so the dead login cannot come back.
  writeJson(f.liveCredentials, {
    ...readJson(f.liveCredentials),
    claudeAiOauth: { ...login("dead"), accessToken: "", refreshToken: "", expiresAt: 0 },
  });
  await mod.activateClaudeCliAccount(f.store, "personal", { knownProfileIds });
  const deadVault = readJson(f.vault(ACCOUNT_A));
  assert.deepEqual(deadVault.store, {}, "the dead login's trailing copy is dropped");
  assert.equal(deadVault.oauthAccount.accountUuid, "uuid-a", "the recorded account stays for display");

  // Clearing the live profile removes only its account keys.
  await mod.clearClaudeProfileLogin(f.store, "personal");
  const cleared = readJson(f.liveCredentials);
  assert.equal(cleared.claudeAiOauth, undefined);
  assert.ok(cleared.mcpOAuth["posthog|1"], "signing an account out keeps the MCP grants");
  assert.equal(fs.existsSync(f.vault("personal")), false);
  console.log("PASS dead and signed-out logins never come back, and MCP grants outlive them");

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

  // --- Identities never cross accounts -------------------------------------
  // The retired slot swap left `.claude.json` naming the managed account
  // while the home held the user's own login. The first marker must not
  // record that account for the personal login, and switching away must not
  // file it in the personal vault.
  {
    const g = fixture("stale-identity");
    const mainAccount = { accountUuid: "uuid-main", emailAddress: "main@example.com", displayName: "Main" };
    writeJson(g.liveCredentials, { claudeAiOauth: login("own") });
    writeJson(g.liveConfig, { oauthAccount: mainAccount }, 0o644);
    writeJson(path.join(g.accountDir(ACCOUNT_A), ".credentials.json"), { claudeAiOauth: login("main") });
    writeJson(path.join(g.accountDir(ACCOUNT_A), ".claude.json"), { oauthAccount: mainAccount });
    await mod.migrateClaudeToOneHome({ store: g.store, managedProfileIds: [ACCOUNT_A] });
    assert.equal(readJson(g.marker).accountUuid, undefined, "the stale account is dropped from the marker");
    await mod.activateClaudeCliAccount(g.store, ACCOUNT_A, {
      knownProfileIds: async () => ["personal", ACCOUNT_A],
    });
    const personal = readJson(g.vault("personal"));
    assert.equal(personal.store.claudeAiOauth.refreshToken, "refresh-own", "the own login is saved as personal");
    assert.equal(personal.oauthAccount, undefined, "without the managed account's identity");
    assert.equal(readJson(g.liveConfig).oauthAccount.accountUuid, "uuid-main");

    // Recording another account replaces the record whole; the same account merges.
    await mod.writeClaudeProfileIdentity(g.store, "personal", { accountUuid: "uuid-own", emailAddress: "own@example.com" });
    await mod.writeClaudeProfileIdentity(g.store, "personal", { accountUuid: "uuid-own", organizationUuid: "org-own" });
    assert.deepEqual(readJson(g.vault("personal")).oauthAccount, {
      accountUuid: "uuid-own",
      emailAddress: "own@example.com",
      organizationUuid: "org-own",
    });
    await mod.writeClaudeProfileIdentity(g.store, "personal", { accountUuid: "uuid-other", emailAddress: "other@example.com" });
    assert.deepEqual(readJson(g.vault("personal")).oauthAccount, {
      accountUuid: "uuid-other",
      emailAddress: "other@example.com",
    });
    await mod.forgetClaudeVaultIdentity(g.store, "personal");
    assert.equal(readJson(g.vault("personal")).oauthAccount, undefined);
    assert.equal(readJson(g.vault("personal")).store.claudeAiOauth.refreshToken, "refresh-own", "the login stays");
    await mod.forgetClaudeVaultIdentity(g.store, ACCOUNT_A);
    assert.equal(readJson(g.liveConfig).oauthAccount.accountUuid, "uuid-main", "a live identity is Claude Code's");
    console.log("PASS an identity is never filed under another account's login");
  }

  // --- Directories of accounts no longer registered ------------------------
  {
    const o = fixture("orphans");
    const ORPHAN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const KEPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    writeJson(o.liveCredentials, { claudeAiOauth: login("own") });
    const project = "-work-codara";
    const homeProjects = path.join(o.store.personalConfigDir, "projects", project);
    fs.mkdirSync(homeProjects, { recursive: true });
    fs.writeFileSync(path.join(homeProjects, "shared.jsonl"), "home copy\n");
    const orphanProjects = path.join(o.accountDir(ORPHAN), "projects", project);
    fs.mkdirSync(orphanProjects, { recursive: true });
    fs.writeFileSync(path.join(orphanProjects, "only-there.jsonl"), "transcript\n");
    fs.writeFileSync(path.join(orphanProjects, "shared.jsonl"), "orphan copy\n");
    writeJson(path.join(o.accountDir(ORPHAN), ".claude.json"), { projects: {} });
    // An unregistered directory that still holds a login is the user's call.
    writeJson(path.join(o.accountDir(KEPT), ".credentials.json"), { claudeAiOauth: login("kept") });
    const logs = [];
    const result = await mod.migrateClaudeToOneHome({
      store: o.store,
      managedProfileIds: [],
      log: (line) => logs.push(line),
    });
    assert.deepEqual(result.orphans, [ORPHAN]);
    assert.equal(fs.existsSync(o.accountDir(ORPHAN)), false);
    assert.equal(fs.readFileSync(path.join(homeProjects, "only-there.jsonl"), "utf8"), "transcript\n");
    assert.equal(fs.readFileSync(path.join(homeProjects, "shared.jsonl"), "utf8"), "home copy\n", "never replaced");
    assert.equal(fs.existsSync(path.join(o.accountDir(KEPT), ".credentials.json")), true);
    assert.ok(logs.some((line) => line.includes("1 transcript(s) moved")));
    console.log("PASS an unregistered account directory goes once its transcripts are home; one with a login stays");
  }

  // --- A /login in a terminal as another known account ---------------------
  {
    const n = fixture("native-login");
    writeJson(n.marker, { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a" });
    writeJson(n.vault(ACCOUNT_A), { version: 1, store: { claudeAiOauth: login("a") }, oauthAccount: { accountUuid: "uuid-a" } });
    writeJson(n.vault(ACCOUNT_B), { version: 1, store: { claudeAiOauth: login("b-old") }, oauthAccount: { accountUuid: "uuid-b" } });
    // Claude Code's /login replaced the live login and recorded the account.
    writeJson(n.liveCredentials, { claudeAiOauth: login("b-new"), mcpOAuth: { "server|1": { accessToken: "grant" } } });
    writeJson(n.liveConfig, { oauthAccount: { accountUuid: "uuid-b", emailAddress: "b@example.com" } }, 0o644);
    const known = [ACCOUNT_A, ACCOUNT_B];
    const verifiedAs = (uuid) => async (token) => (token === "access-b-new" ? uuid : undefined);

    assert.equal(await mod.detectClaudeNativeLogin(n.store, known, verifiedAs("uuid-other")), null, "the token decides");
    const change = await mod.detectClaudeNativeLogin(n.store, known, verifiedAs("uuid-b"));
    assert.deepEqual(change, { from: ACCOUNT_A, to: ACCOUNT_B, accountUuid: "uuid-b" });
    assert.equal(await mod.adoptClaudeNativeLogin(n.store, change), true);
    assert.equal(readJson(n.marker).profileId, ACCOUNT_B);
    assert.equal(readJson(n.marker).accountUuid, "uuid-b");
    assert.equal(readJson(n.vault(ACCOUNT_B)).store.claudeAiOauth.refreshToken, "refresh-b-new", "the new login is B's now");
    assert.equal(readJson(n.vault(ACCOUNT_A)).store.claudeAiOauth.refreshToken, "refresh-a", "A keeps its own");
    assert.equal(readJson(n.liveCredentials).claudeAiOauth.refreshToken, "refresh-b-new", "the live login is untouched");
    assert.equal(await mod.detectClaudeNativeLogin(n.store, known, verifiedAs("uuid-b")), null, "and it settles");
    assert.equal(await mod.adoptClaudeNativeLogin(n.store, change), false, "a stale change is refused");

    // An account two profiles record, or one no profile records, is left alone.
    writeJson(n.marker, { version: 1, profileId: ACCOUNT_A, accountUuid: "uuid-a" });
    writeJson(n.vault("personal"), { version: 1, store: {}, oauthAccount: { accountUuid: "uuid-b" } });
    assert.equal(await mod.detectClaudeNativeLogin(n.store, known, verifiedAs("uuid-b")), null);
    writeJson(n.liveConfig, { oauthAccount: { accountUuid: "uuid-new" } }, 0o644);
    assert.equal(await mod.detectClaudeNativeLogin(n.store, known, verifiedAs("uuid-new")), null);
    console.log("PASS a terminal /login as another known account makes it the live one, checked against the token");
  }

  console.log("\nPASS Claude accounts in one home");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
