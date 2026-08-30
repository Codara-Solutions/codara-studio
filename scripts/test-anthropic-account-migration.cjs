#!/usr/bin/env node
"use strict";

// The idempotent startup pass that folds an earlier Studio's account layout
// into the unified two-halves model, against real temp roots and the real
// pinned Pi AuthStorage. The Keychain is an in-memory map.
//
//   node scripts/test-anthropic-account-migration.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-account-migration-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

const CLI = {
  swapped: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  byFingerprint: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  byEmail: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  mismatch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  lonely: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
  gone: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
};
const UUID = {
  personal: "11111111-2222-4333-8444-555555555555",
  swapped: "21111111-2222-4333-8444-555555555555",
  byFingerprint: "31111111-2222-4333-8444-555555555555",
  mismatchCora: "41111111-2222-4333-8444-555555555555",
  mismatchCli: "51111111-2222-4333-8444-555555555555",
};
const fingerprintOf = (uuid) => crypto.createHash("sha256").update(uuid.toLowerCase()).digest("hex");
const PADDING = 5 * 60 * 1000;
const T0 = 1_900_000_000_000;

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("anthropic-accounts.ts"))};`,
      `export * as migration from ${JSON.stringify(orchestration("anthropic-account-migration.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
      `export * as execution from ${JSON.stringify(orchestration("claude-cli-profile-execution.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("anthropic-credential-mirror.ts"))};`,
      `export * as credentials from ${JSON.stringify(orchestration("claude-cli-credentials.ts"))};`,
    ].join("\n"),
  );
  const out = path.join(TMP, "harness.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "migration-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /pi-runtime-electron$/ }, () => ({
            path: "runtime-electron",
            namespace: "stub",
          }));
          build.onLoad({ filter: /^runtime-electron$/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); }`,
          }));
          // The service invalidates the usage and model caches after a
          // mutation; both modules pull Electron, and the suite injects its
          // own invalidator anyway.
          build.onResolve({ filter: /pi-subscription-usage$/ }, () => ({ path: "usage", namespace: "stub" }));
          build.onLoad({ filter: /^usage$/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export function invalidatePiSubscriptionUsageCache() {}`,
          }));
          build.onResolve({ filter: /pi-model-catalog$/ }, () => ({ path: "catalog", namespace: "stub" }));
          build.onLoad({ filter: /^catalog$/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export function invalidatePiModelCatalogCache() {}`,
          }));
        },
      },
    ],
  });
  return require(out);
}

async function loadAuthStorage() {
  const loaded = await import(
    pathToFileURL(path.join(PI_PACKAGE_ROOT, "dist", "core", "auth-storage.js")).href
  );
  return loaded.AuthStorage;
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function privateFile(file, content) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();
  const keychain = new Map();
  const backend = {
    async read(configDir, configDirEnv) {
      return (
        keychain.get(H.credentials.claudeCliKeychainService(configDirEnv)) ??
        H.credentials.readCredentialFile(H.credentials.claudeCredentialFile(configDir))
      );
    },
    async write(configDir, configDirEnv, credential) {
      await H.credentials.atomicWriteCredential(
        H.credentials.claudeCredentialFile(configDir),
        credential,
      );
      keychain.set(H.credentials.claudeCliKeychainService(configDirEnv), credential);
    },
    async clear(configDir, configDirEnv) {
      keychain.delete(H.credentials.claudeCliKeychainService(configDirEnv));
      fs.rmSync(H.credentials.claudeCredentialFile(configDir), { force: true });
    },
  };
  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const claudeRoot = path.join(HOME, ".codarastudio", "claude-cli");
  const personalDir = path.join(HOME, ".claude");
  privateDir(personalDir);
  const claudeCredential = (name, n, extra = {}) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `${name}-access-${n}`,
        refreshToken: `${name}-refresh-${n}`,
        expiresAt: T0 + n * 1000,
        scopes: ["user:inference"],
        ...extra,
      },
    });
  const piCredential = (name, n) => ({
    type: "oauth",
    access: `${name}-access-${n}`,
    refresh: `${name}-refresh-${n}`,
    expires: T0 + n * 1000 - PADDING,
  });
  const managedDir = (cliId) => H.claudeProfiles.claudeCliManagedProfileConfigDir(claudeRoot, cliId);
  const readSlot = async (configDir, configDirEnv) =>
    H.credentials.parseClaudeCredentialRecord(await backend.read(configDir, configDirEnv));
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) =>
    fs.existsSync(piAuthFile(coraId))
      ? JSON.parse(fs.readFileSync(piAuthFile(coraId), "utf8")).anthropic ?? null
      : null;

  // The old layout: a managed account swapped into ~/.claude, the personal
  // login vaulted, a marker naming the swap, and a stale copy in the managed
  // directory itself (the token has been refreshed since the swap).
  const cliMeta = (id, label) => ({
    id,
    label,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  privateDir(claudeRoot);
  privateFile(
    path.join(claudeRoot, "account-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        cliMeta(CLI.swapped, "Swapped"),
        cliMeta(CLI.byFingerprint, "Paired by fingerprint"),
        cliMeta(CLI.byEmail, "Paired by email"),
        cliMeta(CLI.mismatch, "Mismatch"),
        cliMeta(CLI.lonely, "Lonely terminal"),
      ],
      defaultProfileId: CLI.swapped,
    }),
  );
  for (const id of Object.values(CLI)) {
    if (id === CLI.gone) continue;
    privateDir(managedDir(id));
  }
  privateFile(path.join(claudeRoot, "active-auth.json"), JSON.stringify({ version: 1, profileId: CLI.swapped }));
  privateFile(path.join(claudeRoot, "personal", ".credentials.json"), claudeCredential("personal", 4));
  privateFile(path.join(claudeRoot, "personal", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: UUID.personal, emailAddress: "me@example.com" } }));
  privateFile(path.join(personalDir, ".credentials.json"), claudeCredential("swapped", 9));
  privateFile(path.join(managedDir(CLI.swapped), ".credentials.json"), claudeCredential("swapped", 2));
  privateFile(path.join(managedDir(CLI.swapped), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: UUID.swapped, emailAddress: "swapped@example.com" } }));
  privateFile(path.join(managedDir(CLI.byFingerprint), ".credentials.json"), claudeCredential("fp", 3));
  privateFile(path.join(managedDir(CLI.byFingerprint), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: UUID.byFingerprint, emailAddress: "fp@example.com" } }));
  privateFile(path.join(managedDir(CLI.byEmail), ".credentials.json"), claudeCredential("email", 7));
  privateFile(path.join(managedDir(CLI.byEmail), ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "Email@Example.com" } }));
  privateFile(path.join(managedDir(CLI.mismatch), ".credentials.json"), claudeCredential("mismatch", 1));
  privateFile(path.join(managedDir(CLI.mismatch), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: UUID.mismatchCli, emailAddress: "shared@example.com" } }));
  privateFile(path.join(managedDir(CLI.lonely), ".credentials.json"), claudeCredential("lonely", 1));
  // ~/.claude.json, where Claude Code keeps the identity when
  // CLAUDE_CONFIG_DIR is unset. The selector swapped only the credential, so
  // the file still names the managed account that last ran against ~/.claude.
  privateFile(path.join(HOME, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: UUID.swapped, emailAddress: "swapped@example.com" } }));
  // A retired vault from a previous (crashed) launch is swept.
  privateFile(path.join(claudeRoot, ".personal.retired-deadbeef", ".credentials.json"), claudeCredential("old", 1));

  // The Cora side: rows in every pairing situation.
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const register = async (label, options = {}) => {
    const { profile } = await piStore.registry.registerProfile({
      provider: "anthropic",
      label,
      ...(options.fingerprint ? { identityFingerprint: options.fingerprint } : {}),
      ...(options.email ? { accountEmail: options.email } : {}),
      ...(options.cliProfileId ? { cliProfileId: options.cliProfileId } : {}),
    });
    if (options.credential) {
      const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, profile.id);
      privateDir(configDir);
      await AuthStorage.create(authFile).modify("anthropic", async () => options.credential);
      fs.chmodSync(authFile, 0o600);
    }
    return profile;
  };
  const rowSwapped = await register("Swapped", {
    fingerprint: fingerprintOf(UUID.swapped),
    email: "swapped@example.com",
    credential: piCredential("swapped-cora", 5),
  });
  const rowByFingerprint = await register("FP row", {
    fingerprint: fingerprintOf(UUID.byFingerprint),
    email: "unrelated@example.com",
    credential: piCredential("fp-cora", 1),
  });
  const rowByEmail = await register("Email row", {
    email: "email@example.com",
    credential: piCredential("email-cora", 9),
  });
  const rowMismatch = await register("Mismatch row", {
    fingerprint: fingerprintOf(UUID.mismatchCora),
    email: "shared@example.com",
    credential: piCredential("mismatch-cora", 1),
  });
  const rowDangling = await register("Dangling", {
    cliProfileId: CLI.gone,
    credential: piCredential("dangling", 1),
  });
  const rowCoraOnly = await register("Cora only", {
    credential: piCredential("cora-only", 1),
  });
  await piStore.registry.setDefaultProfile("anthropic", rowSwapped.id);
  // The legacy root auth.json still folds into a row.
  privateFile(path.join(piRoot, "auth.json"), JSON.stringify({ anthropic: piCredential("legacy", 2) }));

  const leases = new H.execution.ClaudeCliProfileLeaseRegistry();
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: personalDir,
    personalConfigDirEnv: null,
    leases,
    authChecker: (input) =>
      H.claudeProfiles.claudeCredentialAuthChecker(input, { backend, personalFallback: null }),
  });
  const mirror = new H.mirror.AnthropicCredentialMirror({
    backend,
    loadAuthStorage,
    keychainPoll: null,
    debounceMs: 30,
    retryDelayMs: 20,
  });
  const logs = [];
  const service = new H.accounts.AnthropicAccountService({
    piStore,
    claudeStore,
    leases,
    mirror,
    backend,
    loadAuthStorage,
    readIdentity: async () => ({}),
    homeDir: HOME,
    invalidateCaches: async () => undefined,
    platform: "linux",
    log: (message) => logs.push(message),
  });
  const deps = { service, piStore, claudeStore, backend, log: (message) => logs.push(message) };

  const report = await H.migration.migrateAnthropicAccounts(deps);
  assert.equal(report.failedStep, null, JSON.stringify(report));

  // Live slot undone: the swapped account got its fresher token back, the
  // personal login is back in ~/.claude, the vault and marker are gone.
  assert.equal(report.liveSlot.restoredFrom, CLI.swapped);
  assert.equal(report.liveSlot.personalRestored, true);
  assert.deepEqual(report.liveSlot.removedRetiredDirs, [".personal.retired-deadbeef"]);
  assert.equal(fs.existsSync(path.join(claudeRoot, "active-auth.json")), false);
  assert.equal(fs.existsSync(path.join(claudeRoot, "personal")), false);
  assert.ok(fs.existsSync(report.liveSlot.retiredVaultDir));
  assert.equal((await readSlot(personalDir, null)).accessToken, "personal-access-4");
  assert.equal((await readSlot(managedDir(CLI.swapped), managedDir(CLI.swapped))).accessToken, "swapped-access-9");
  // The personal identity came back with the credential, and the rest of
  // ~/.claude.json survived the merge.
  assert.equal(report.liveSlot.identityRestored, true);
  const homeConfig = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
  assert.equal(homeConfig.oauthAccount.accountUuid, UUID.personal);
  assert.equal(homeConfig.oauthAccount.emailAddress, "me@example.com");
  assert.equal(homeConfig.hasCompletedOnboarding, true);
  pass("the live-slot swap is undone and the fresher token stays with its account");

  // Pairing: fingerprint, then email when a fingerprint verdict is impossible,
  // never across differing fingerprints; the first reconcile makes the newer
  // token win on both sides.
  const byId = async (id) => piStore.registry.getProfile(id);
  assert.equal((await byId(rowSwapped.id)).cliProfileId, CLI.swapped);
  assert.equal((await byId(rowByFingerprint.id)).cliProfileId, CLI.byFingerprint);
  assert.equal((await byId(rowByEmail.id)).cliProfileId, CLI.byEmail);
  assert.equal((await byId(rowMismatch.id)).cliProfileId, undefined);
  assert.equal((await byId(rowCoraOnly.id)).cliProfileId, undefined);
  assert.deepEqual(
    report.paired.map((entry) => `${entry.coraProfileId}:${entry.by}`).sort(),
    [`${rowByEmail.id}:email`, `${rowByFingerprint.id}:fingerprint`, `${rowSwapped.id}:fingerprint`].sort(),
  );
  assert.equal(readPi(rowSwapped.id).access, "swapped-access-9", "the terminal's fresher token flowed to Cora");
  assert.equal((await readSlot(managedDir(CLI.byFingerprint), managedDir(CLI.byFingerprint))).accessToken, "fp-access-3");
  assert.equal(readPi(rowByFingerprint.id).access, "fp-access-3");
  assert.equal((await readSlot(managedDir(CLI.byEmail), managedDir(CLI.byEmail))).accessToken, "email-cora-access-9", "Cora's fresher token flowed to the terminal");
  assert.equal((await readSlot(managedDir(CLI.mismatch), managedDir(CLI.mismatch))).accessToken, "mismatch-access-1");
  assert.equal(readPi(rowMismatch.id).access, "mismatch-cora-access-1");
  assert.ok(logs.some((line) => line.includes("by email")), "email pairs are logged for support");
  pass("halves pair by fingerprint, then by email, never across differing fingerprints");

  // Dangling link cleared; Account 1 created and paired with ~/.claude.
  assert.deepEqual(report.clearedLinks, [rowDangling.id]);
  assert.equal((await byId(rowDangling.id)).cliProfileId, undefined);
  const accountOne = await piStore.registry.accountOneProfile();
  assert.equal(accountOne.id, report.accountOne);
  assert.equal(accountOne.label, "Account 1");
  assert.equal(accountOne.identityFingerprint, fingerprintOf(UUID.personal));
  assert.equal(readPi(accountOne.id).access, "personal-access-4");
  pass("dangling links are cleared and Account 1 is created from ~/.claude");

  // Defaults: Cora's default row wins, Claude Code follows its link.
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, rowSwapped.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, CLI.swapped);
  // Unpaired halves are still there for the Share action.
  const listed = await service.listAnthropicAccounts();
  assert.deepEqual(listed.terminalOnly.map((entry) => entry.cliProfileId).sort(), [CLI.lonely, CLI.mismatch].sort());
  assert.ok(listed.accounts.some((entry) => entry.coraProfileId === rowCoraOnly.id && entry.cliProfileId === null));
  assert.ok(
    listed.accounts.some((entry) => readPi(entry.coraProfileId)?.access === "legacy-access-2"),
    "the legacy auth.json folded into a row",
  );
  assert.equal(fs.existsSync(path.join(piRoot, "auth.json")), false);
  assert.equal(report.watchedPairs, 4);
  pass("defaults are repaired and unpaired halves survive as separate cards");

  // Rerun: nothing changes, the retired vault is swept.
  const before = fs.readFileSync(path.join(piRoot, "account-profiles.json"), "utf8");
  const rerun = await H.migration.migrateAnthropicAccounts(deps);
  assert.equal(rerun.failedStep, null);
  assert.deepEqual(rerun.paired, []);
  assert.deepEqual(rerun.clearedLinks, []);
  assert.equal(rerun.liveSlot.restoredFrom, null);
  assert.equal(rerun.liveSlot.retiredVaultDir, null);
  assert.deepEqual(rerun.liveSlot.removedRetiredDirs, [path.basename(report.liveSlot.retiredVaultDir)]);
  assert.equal(fs.readFileSync(path.join(piRoot, "account-profiles.json"), "utf8"), before);
  assert.equal(readPi(rowSwapped.id).access, "swapped-access-9");
  pass("the pass is idempotent");

  // Crash after pairing: a link recorded with a stale Pi copy is repaired by
  // the next pass, and a missing Cora default derives from the Claude default.
  const { authFile: fpAuth } = H.piStore.piAccountProfilePaths(piRoot, rowByFingerprint.id);
  await AuthStorage.create(fpAuth).modify("anthropic", async () => piCredential("stale", 0));
  await piStore.registry.setDefaultProfile("anthropic", null);
  await claudeStore.setDefaultProfile(CLI.byFingerprint);
  const resumed = await H.migration.migrateAnthropicAccounts(deps);
  assert.equal(resumed.failedStep, null);
  assert.equal(readPi(rowByFingerprint.id).access, "fp-access-3");
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, rowByFingerprint.id);
  // No Cora default and Claude on personal: Account 1 becomes the default.
  await piStore.registry.setDefaultProfile("anthropic", null);
  await claudeStore.setDefaultProfile("personal");
  await H.migration.migrateAnthropicAccounts(deps);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, accountOne.id);
  // An unlinked managed Claude default is left alone.
  await piStore.registry.setDefaultProfile("anthropic", null);
  await claudeStore.setDefaultProfile(CLI.lonely);
  await H.migration.migrateAnthropicAccounts(deps);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, undefined);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, CLI.lonely);
  pass("a crash after pairing resumes and default repair follows the documented rules");

  // The ready gate resolves even when a step fails, and installs the launch hooks.
  H.migration.resetAnthropicAccountMigrationForTests();
  const failing = Object.create(service);
  failing.clearDanglingLinks = async () => {
    throw new Error("boom");
  };
  await H.migration.startAnthropicAccountMigration({ ...deps, service: failing });
  await H.migration.unifiedAccountsReady();
  assert.ok(logs.some((line) => line.includes('step "clear-dangling-links" failed')));
  H.migration.resetAnthropicAccountMigrationForTests();
  pass("the ready gate resolves after a failed step");

  // undoLiveSlotSwap on its own: an unreadable ~/.claude defers the whole
  // restore (marker and vault kept, nothing written), and a stale marker
  // naming a profile the registry no longer has copies its token nowhere.
  // Each case gets its own Keychain map: the personal slot's base service is
  // one item per Keychain, and the fixture above already holds it.
  const isolatedBackend = () => {
    const items = new Map();
    const isolated = {
      async read(configDir, configDirEnv) {
        return (
          items.get(H.credentials.claudeCliKeychainService(configDirEnv)) ??
          H.credentials.readCredentialFile(H.credentials.claudeCredentialFile(configDir))
        );
      },
      async write(configDir, configDirEnv, credential) {
        await H.credentials.atomicWriteCredential(
          H.credentials.claudeCredentialFile(configDir),
          credential,
        );
        items.set(H.credentials.claudeCliKeychainService(configDirEnv), credential);
      },
      async clear(configDir, configDirEnv) {
        items.delete(H.credentials.claudeCliKeychainService(configDirEnv));
        fs.rmSync(H.credentials.claudeCredentialFile(configDir), { force: true });
      },
    };
    return { items, isolated };
  };
  {
    const { isolated } = isolatedBackend();
    const readIsolated = async (configDir, configDirEnv) =>
      H.credentials.parseClaudeCredentialRecord(await isolated.read(configDir, configDirEnv));
    const root = path.join(TMP, "undo-deferred");
    const personal = path.join(TMP, "undo-deferred-home", ".claude");
    privateDir(personal);
    privateFile(path.join(root, "active-auth.json"), JSON.stringify({ version: 1, profileId: CLI.swapped }));
    privateFile(path.join(root, "personal", ".credentials.json"), claudeCredential("vaulted", 1));
    privateFile(path.join(personal, ".credentials.json"), claudeCredential("live", 9));
    const locked = {
      ...isolated,
      async read(configDir, configDirEnv) {
        if (configDir === personal) throw new Error("Claude Code credential could not be read from Keychain");
        return isolated.read(configDir, configDirEnv);
      },
    };
    const deferredLogs = [];
    const deferred = await H.migration.undoLiveSlotSwap({
      claudeRootDir: root,
      personalConfigDir: personal,
      personalConfigDirEnv: null,
      backend: locked,
      managedProfileExists: async () => true,
      log: (message) => deferredLogs.push(message),
    });
    assert.match(deferred.deferred, /Keychain/);
    assert.equal(deferred.restoredFrom, null);
    assert.equal(deferred.personalRestored, false);
    assert.ok(fs.existsSync(path.join(root, "active-auth.json")), "the marker stays for the next launch");
    assert.ok(fs.existsSync(path.join(root, "personal", ".credentials.json")), "the vault stays too");
    assert.equal(fs.existsSync(managedDir(CLI.swapped).replace(claudeRoot, root)), false);
    assert.equal((await readIsolated(personal, null)).accessToken, "live-access-9", "~/.claude is untouched");
    assert.ok(deferredLogs.some((line) => line.includes("kept for the next launch")));
    // Next launch, Keychain readable: the restore completes.
    const completed = await H.migration.undoLiveSlotSwap({
      claudeRootDir: root,
      personalConfigDir: personal,
      personalConfigDirEnv: null,
      backend: isolated,
      managedProfileExists: async () => true,
    });
    assert.equal(completed.restoredFrom, CLI.swapped);
    assert.equal(completed.personalRestored, true);
    assert.equal(fs.existsSync(path.join(root, "active-auth.json")), false);
    assert.equal((await readIsolated(personal, null)).accessToken, "vaulted-access-1");
    assert.equal(
      (await readIsolated(path.join(root, "accounts", CLI.swapped), path.join(root, "accounts", CLI.swapped))).accessToken,
      "live-access-9",
      "the fresher token went back to its own directory",
    );
    pass("an unreadable ~/.claude defers the live-slot restore instead of losing the token");
  }
  {
    const { items, isolated } = isolatedBackend();
    const readIsolated = async (configDir, configDirEnv) =>
      H.credentials.parseClaudeCredentialRecord(await isolated.read(configDir, configDirEnv));
    const root = path.join(TMP, "undo-stale");
    const personal = path.join(TMP, "undo-stale-home", ".claude");
    privateDir(personal);
    privateFile(path.join(root, "active-auth.json"), JSON.stringify({ version: 1, profileId: CLI.gone }));
    privateFile(path.join(root, "personal", ".credentials.json"), claudeCredential("vaulted", 2));
    privateFile(path.join(personal, ".credentials.json"), claudeCredential("orphaned", 5));
    const staleLogs = [];
    const stale = await H.migration.undoLiveSlotSwap({
      claudeRootDir: root,
      personalConfigDir: personal,
      personalConfigDirEnv: null,
      backend: isolated,
      managedProfileExists: async (id) => id !== CLI.gone,
      log: (message) => staleLogs.push(message),
    });
    assert.equal(stale.restoredFrom, null);
    assert.equal(stale.personalRestored, true);
    assert.equal(fs.existsSync(path.join(root, "accounts", CLI.gone)), false, "no orphan directory is conjured");
    assert.equal(items.has(H.credentials.claudeCliKeychainService(path.join(root, "accounts", CLI.gone))), false);
    assert.equal(fs.existsSync(path.join(root, "active-auth.json")), false);
    assert.equal((await readIsolated(personal, null)).accessToken, "vaulted-access-2");
    assert.ok(staleLogs.some((line) => line.includes("no longer exists")));
    pass("a stale marker naming a deleted profile copies its token nowhere");
  }

  // No file with group/other bits anywhere under the Codara home.
  const offending = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else if (/auth\.json$|\.credentials\.json$|account-profiles\.json$/.test(entry.name) && (mode(file) & 0o077) !== 0) {
        offending.push(file);
      }
    }
  };
  visit(path.join(HOME, ".codarastudio"));
  visit(personalDir);
  assert.deepEqual(offending, []);
  pass("no credential or registry file is readable by group or other users");

  mirror.stop();
  service.stop();
  console.log(`\nPASS anthropic account migration (${passes} groups)`);
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
