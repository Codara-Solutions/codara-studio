#!/usr/bin/env node
"use strict";

// The unified Anthropic account service against real temp roots: a real Pi
// account store and registry, a real managed Claude Code profile store, the
// real credential mirror and the REAL pinned Pi AuthStorage. Only the
// Keychain (an in-memory map), the network identity lookup and the terminal
// session table are stubbed.
//
//   node scripts/test-anthropic-accounts.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-anthropic-accounts-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

const CLI_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
];
const CLI_IDS_2 = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
];
const UUID_A = "a1111111-1111-4111-8111-111111111111";
const UUID_B = "b2222222-2222-4222-8222-222222222222";
const UUID_C = "c3333333-3333-4333-8333-333333333333";
const ACCOUNT_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
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
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as claudeCodec from ${JSON.stringify(orchestration("account-adapters/claude-credential-codec.ts"))};`,
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
        name: "accounts-harness",
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
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.ClaudeCliProfileLeaseRegistry();
  let cliIndex = 0;
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: personalDir,
    personalConfigDirEnv: null,
    leases,
    idFactory: () => CLI_IDS[cliIndex++],
    authChecker: (input) =>
      H.claudeProfiles.claudeCredentialAuthChecker(input, { backend, personalFallback: null }),
  });
  const mirror = new H.mirror.CredentialMirror({
    loadAuthStorage,
    pollWhenWatchBlind: null,
    debounceMs: 30,
    retryDelayMs: 20,
  });
  let networkIdentity = {};
  let broadcasts = 0;
  let invalidations = 0;
  const liveOwners = new Set();
  const disposed = [];
  const logs = [];
  const service = new H.accounts.AnthropicAccountService({
    piStore,
    claudeStore,
    leases,
    mirror,
    backend,
    loadAuthStorage,
    readIdentity: async () => networkIdentity,
    homeDir: HOME,
    invalidateCaches: async () => {
      invalidations += 1;
    },
    broadcast: () => {
      broadcasts += 1;
    },
    sessions: {
      liveOwnerIds: () => liveOwners,
      disposeProfileSessions: async (profileId) => {
        disposed.push(profileId);
        let count = 0;
        for (const owner of leases.owners(profileId)) {
          if (owner.startsWith("terminal:")) {
            liveOwners.delete(owner);
            count += 1;
          }
        }
        // The pty layer's lease-release hook reconciles the profile the
        // terminal ran on, in the middle of the delete that closed it.
        void service.reconcileCliProfile(profileId).catch(() => null);
        return { closedSessionCount: count };
      },
    },
    platform: "linux",
    log: (message) => logs.push(message),
  });

  const piCredential = (n) => ({
    type: "oauth",
    access: `pi-access-${n}`,
    refresh: `pi-refresh-${n}`,
    expires: T0 + n * 1000 - PADDING,
  });
  const claudeCredential = (n, extra = {}) => ({
    accessToken: `claude-access-${n}`,
    refreshToken: `claude-refresh-${n}`,
    expiresAt: T0 + n * 1000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    ...extra,
  });
  const writeClaudeSlot = (configDir, configDirEnv, record) =>
    backend.write(configDir, configDirEnv, JSON.stringify({ claudeAiOauth: record }));
  const readClaudeSlot = async (configDir, configDirEnv) =>
    H.credentials.parseClaudeCredentialRecord(await backend.read(configDir, configDirEnv));
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) =>
    fs.existsSync(piAuthFile(coraId))
      ? JSON.parse(fs.readFileSync(piAuthFile(coraId), "utf8")).anthropic ?? null
      : null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(authFile).modify("anthropic", async () => credential);
    fs.chmodSync(authFile, 0o600);
  };
  const managedDir = (cliId) => H.claudeProfiles.claudeCliManagedProfileConfigDir(claudeRoot, cliId);
  const connectCora = async (label, n, identity = {}) => {
    const target = await piStore.prepareCredentialTarget({
      provider: "anthropic",
      label,
      ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
      ...(identity.email ? { accountEmail: identity.email } : {}),
    });
    await writePi(target.profile.id, piCredential(n));
    return target.profile;
  };

  // No credential in ~/.claude: no Account 1 row, nothing created.
  assert.equal(await service.ensureAccountOne(), null);
  assert.deepEqual(await piStore.registry.listProfiles(), []);
  pass("ensureAccountOne creates nothing while ~/.claude holds no login");

  // ~/.claude gets a login (identity in ~/.claude.json, as Claude Code writes it).
  await writeClaudeSlot(personalDir, null, claudeCredential(2));
  fs.writeFileSync(
    path.join(HOME, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: ACCOUNT_UUID, emailAddress: "one@example.com" },
    }),
    { mode: 0o600 },
  );
  const accountOne = await service.ensureAccountOne();
  assert.equal(accountOne.label, "Account 1");
  assert.equal(accountOne.cliProfileId, "personal");
  assert.equal(accountOne.identityFingerprint, fingerprintOf(ACCOUNT_UUID));
  assert.equal(accountOne.accountEmail, "one@example.com");
  assert.deepEqual(readPi(accountOne.id), {
    type: "oauth",
    access: "claude-access-2",
    refresh: "claude-refresh-2",
    expires: T0 + 2000 - PADDING,
  });
  assert.equal(mode(piAuthFile(accountOne.id)), 0o600);
  assert.equal(mode(path.dirname(piAuthFile(accountOne.id))), 0o700);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, accountOne.id);
  assert.equal((await service.ensureAccountOne()).id, accountOne.id, "rerun is idempotent");
  assert.equal((await piStore.registry.listProfiles()).length, 1);
  assert.equal(mirror.pairFor(accountOne.id).cliProfileId, "personal");
  pass("ensureAccountOne creates the Account 1 row from ~/.claude and mirrors its token to Cora");

  // Cora sign-in: the Claude Code half is written from the credential that
  // just arrived, with Claude Code's own identity block.
  networkIdentity = {
    fingerprint: fingerprintOf(OTHER_UUID),
    email: "work@example.com",
    accountUuid: OTHER_UUID,
    organizationUuid: "org-work",
  };
  const work = await connectCora("Work", 5, networkIdentity);
  const canonical = H.claudeCodec.canonicalFromPi(piCredential(5));
  const workCli = await service.ensureCliHalf(work.id, canonical, networkIdentity);
  assert.equal(workCli, CLI_IDS[0]);
  const workDir = managedDir(workCli);
  assert.equal(mode(workDir), 0o700);
  const workRecord = await readClaudeSlot(workDir, workDir);
  assert.equal(workRecord.accessToken, "pi-access-5");
  assert.equal(workRecord.refreshToken, "pi-refresh-5");
  assert.equal(workRecord.expiresAt, T0 + 5000);
  assert.deepEqual(workRecord.scopes, [...H.claudeCodec.ANTHROPIC_OAUTH_SCOPES]);
  assert.equal(mode(H.credentials.claudeCredentialFile(workDir)), 0o600);
  assert.ok(keychain.has(H.credentials.claudeCliKeychainService(workDir)));
  const workConfig = JSON.parse(fs.readFileSync(path.join(workDir, ".claude.json"), "utf8"));
  assert.deepEqual(workConfig.oauthAccount, {
    accountUuid: OTHER_UUID,
    emailAddress: "work@example.com",
    organizationUuid: "org-work",
  });
  assert.equal(workConfig.hasCompletedOnboarding, true, "onboarding seed survives the identity write");
  assert.equal((await piStore.registry.getProfile(work.id)).cliProfileId, workCli);
  assert.equal(mirror.pairFor(work.id).location.configDir, workDir);
  assert.equal(await service.ensureCliHalf(work.id, canonical), workCli, "a linked row keeps its half");
  pass("ensureCliHalf writes the managed Claude Code half and records the link");

  // A failure while building the half leaves no directory and no link.
  const fragile = await connectCora("Fragile", 3);
  const failingBackend = {
    ...backend,
    async write(configDir, configDirEnv, credential) {
      if (configDir.includes(CLI_IDS[1])) throw new Error("disk full");
      return backend.write(configDir, configDirEnv, credential);
    },
  };
  const fragileService = new H.accounts.AnthropicAccountService({
    piStore,
    claudeStore,
    leases,
    mirror,
    backend: failingBackend,
    loadAuthStorage,
    homeDir: HOME,
    invalidateCaches: async () => undefined,
    platform: "linux",
  });
  await assert.rejects(
    () => fragileService.ensureCliHalf(fragile.id, H.claudeCodec.canonicalFromPi(piCredential(3))),
    /disk full/,
  );
  assert.equal((await piStore.registry.getProfile(fragile.id)).cliProfileId, undefined);
  assert.equal(fs.existsSync(managedDir(CLI_IDS[1])), false);
  assert.equal(
    (await claudeStore.snapshot()).profiles.some((entry) => entry.id === CLI_IDS[1]),
    false,
  );
  pass("a failed Claude Code half is rolled back and the row stays a shareable half");

  // Use this account: both defaults move together, nothing is disposed.
  broadcasts = 0;
  invalidations = 0;
  await service.useAccount(work.id);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, work.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, workCli);
  assert.equal(disposed.length, 0);
  assert.ok(broadcasts >= 1 && invalidations >= 1);
  await service.useAccount(accountOne.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, accountOne.id);
  // Rollback: when the Claude side refuses, the Cora default is put back.
  const refusingStore = Object.create(claudeStore);
  refusingStore.setDefaultProfile = async () => {
    throw new Error("claude store refused");
  };
  const refusingService = new H.accounts.AnthropicAccountService({
    piStore,
    claudeStore: refusingStore,
    leases,
    mirror,
    backend,
    loadAuthStorage,
    homeDir: HOME,
    invalidateCaches: async () => undefined,
    platform: "linux",
  });
  await assert.rejects(() => refusingService.useAccount(work.id), /refused/);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, accountOne.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  const empty = (await piStore.registry.registerProfile({ provider: "anthropic", label: "Empty" })).profile;
  await assert.rejects(
    () => service.useAccount(empty.id),
    (error) => error.name === "UnifiedAccountNotConnectedError",
  );
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, accountOne.id);
  await piStore.registry.deleteProfile(empty.id);
  pass("useAccount flips both defaults in one step and rolls back the Cora default on failure");

  // Share from Cora to Claude Code.
  const shared = await service.shareLogin({ coraProfileId: fragile.id });
  assert.equal(shared.coraProfileId, fragile.id);
  assert.equal(shared.cliProfileId, CLI_IDS[2]);
  assert.equal((await readClaudeSlot(managedDir(CLI_IDS[2]), managedDir(CLI_IDS[2]))).accessToken, "pi-access-3");
  assert.equal((await piStore.registry.getProfile(fragile.id)).cliProfileId, CLI_IDS[2]);
  pass("shareLogin gives a Cora-only account its Claude Code half");

  // Share from Claude Code to Cora: a terminal-only managed profile.
  const terminalOnly = await claudeStore.createProfile({ label: "Terminal only" });
  const terminalDir = managedDir(terminalOnly.profile.id);
  await writeClaudeSlot(terminalDir, terminalDir, claudeCredential(8));
  fs.writeFileSync(
    path.join(terminalDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "3d1b3e2e-4a3d-4b6c-8f2e-1a2b3c4d5e6f", emailAddress: "term@example.com" } }),
    { mode: 0o600 },
  );
  await claudeStore.setDefaultProfile(terminalOnly.profile.id);
  const listedBefore = await service.listAccounts();
  assert.deepEqual(
    listedBefore.terminalOnly.map((entry) => entry.cliProfileId),
    [terminalOnly.profile.id],
  );
  assert.equal(listedBefore.terminalOnly[0].terminal.connected, true);
  const sharedCli = await service.shareLogin({ cliProfileId: terminalOnly.profile.id });
  const sharedRow = await piStore.registry.getProfile(sharedCli.coraProfileId);
  assert.equal(sharedRow.label, "Terminal only");
  assert.equal(sharedRow.cliProfileId, terminalOnly.profile.id);
  assert.equal(sharedRow.identityFingerprint, fingerprintOf("3d1b3e2e-4a3d-4b6c-8f2e-1a2b3c4d5e6f"));
  assert.equal(sharedRow.accountEmail, "term@example.com");
  assert.equal(readPi(sharedRow.id).access, "claude-access-8");
  assert.equal(mode(piAuthFile(sharedRow.id)), 0o600);
  assert.equal(
    (await piStore.registry.snapshot()).defaults.anthropic,
    sharedRow.id,
    "sharing the CLI default makes the pair the active account",
  );
  assert.deepEqual(await service.shareLogin({ cliProfileId: terminalOnly.profile.id }), sharedCli);
  assert.deepEqual((await service.listAccounts()).terminalOnly, []);
  pass("shareLogin gives a terminal-only Claude Code profile its Cora half and keeps it active");

  // The unified list carries both halves for every row.
  const listed = await service.listAccounts();
  const byId = new Map(listed.accounts.map((entry) => [entry.coraProfileId, entry]));
  assert.equal(byId.get(accountOne.id).isAccount1, true);
  assert.equal(byId.get(accountOne.id).terminal.connected, true);
  assert.equal(byId.get(work.id).cliProfileId, workCli);
  assert.equal(byId.get(work.id).cora.connected, true);
  assert.equal(byId.get(work.id).terminal.canRefresh, true);
  assert.equal(byId.get(sharedRow.id).isDefault, true);
  const listedJson = JSON.stringify(listed);
  for (const forbidden of [claudeRoot, piRoot, "access-", "refresh-"]) {
    assert.equal(listedJson.includes(forbidden), false, `${forbidden} must not be listed`);
  }
  pass("listAccounts reports both halves without paths or tokens");

  // Delete: the active account hands both defaults to Account 1 first, a
  // leased account is refused until sessions may be closed, and nothing of the
  // Claude Code half survives.
  await assert.rejects(
    () => service.deleteAccount(accountOne.id),
    (error) => error.name === "PiAccountProfileProtectedError",
  );
  const releaseLease = leases.acquire(terminalOnly.profile.id, "terminal:pane-9");
  liveOwners.add("terminal:pane-9");
  broadcasts = 0;
  await assert.rejects(
    () => service.deleteAccount(sharedRow.id),
    (error) => error.name === "UnifiedAccountSessionsError" && error.sessionCount === 1,
  );
  assert.ok(await piStore.registry.getProfile(sharedRow.id), "a refused delete changes nothing");
  assert.equal(
    (await piStore.registry.snapshot()).defaults.anthropic,
    sharedRow.id,
    "a refused delete leaves the Cora default where it was",
  );
  assert.equal(
    (await claudeStore.snapshot()).defaultProfileId,
    terminalOnly.profile.id,
    "a refused delete leaves the Claude Code default where it was",
  );
  assert.equal(broadcasts, 0, "a refused delete emits no broadcast");
  assert.equal(mirror.pairFor(sharedRow.id).cliProfileId, terminalOnly.profile.id, "still watched");
  // The live count reaches the overview so the card's armed Delete is current.
  const listedLeased = await service.listAccounts();
  assert.equal(
    listedLeased.accounts.find((entry) => entry.coraProfileId === sharedRow.id).terminal.liveSessions,
    1,
  );
  const deleted = await service.deleteAccount(sharedRow.id, { closeSessions: true });
  assert.deepEqual(deleted, { deleted: true, closedSessionCount: 1 });
  assert.deepEqual(disposed, [terminalOnly.profile.id]);
  releaseLease();
  assert.equal(
    (await piStore.registry.snapshot()).defaults.anthropic,
    accountOne.id,
    "the delete hands the Cora default to Account 1",
  );
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal(await piStore.registry.getProfile(sharedRow.id), null);
  assert.equal(fs.existsSync(terminalDir), false);
  assert.equal(keychain.has(H.credentials.claudeCliKeychainService(terminalDir)), false);
  assert.equal(fs.existsSync(path.dirname(piAuthFile(sharedRow.id))), false);
  assert.equal(mirror.pairFor(sharedRow.id), undefined);
  // The lease-release hook fired mid-delete; give its reconcile time to
  // land before checking that nothing came back.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(terminalDir), false, "a racing reconcile must not rebuild the half");
  assert.equal(keychain.has(H.credentials.claudeCliKeychainService(terminalDir)), false);
  assert.deepEqual((await claudeStore.reconcile()).orphanProfileIds, []);
  assert.equal(
    fs.readdirSync(path.join(claudeRoot, "accounts")).some((name) => name.includes("deleting")),
    false,
  );
  // A stale lease whose terminal is gone does not block a delete.
  leases.acquire(CLI_IDS[2], "terminal:vanished");
  const ownershipCalls = [];
  const deletedStale = await service.deleteAccount(fragile.id, {
    ownershipGuard: async (profile) => {
      ownershipCalls.push(profile.id);
      return false;
    },
  });
  assert.deepEqual(deletedStale, { deleted: true, closedSessionCount: 0 });
  assert.ok(ownershipCalls.includes(fragile.id));
  assert.equal(leases.isLeased(CLI_IDS[2]), false);
  await assert.rejects(
    () =>
      service.deleteAccount(work.id, {
        ownershipGuard: async () => true,
      }),
    (error) => error.name === "PiAccountProfileProtectedError",
  );
  assert.ok(await piStore.registry.getProfile(work.id));
  pass("deleteAccount hands off to Account 1, respects leases and guards, and removes both halves");

  // A terminal-only profile can be deleted on its own; a linked one cannot.
  const orphan = await claudeStore.createProfile({ label: "Orphan" });
  await claudeStore.setDefaultProfile(orphan.profile.id).catch(() => undefined);
  await writeClaudeSlot(managedDir(orphan.profile.id), managedDir(orphan.profile.id), claudeCredential(1));
  await claudeStore.setDefaultProfile(orphan.profile.id);
  assert.deepEqual(await service.deleteTerminalOnlyProfile(orphan.profile.id), { deleted: true });
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal(fs.existsSync(managedDir(orphan.profile.id)), false);
  await assert.rejects(() => service.deleteTerminalOnlyProfile(workCli), /belongs to an account/);
  assert.deepEqual(await service.deleteTerminalOnlyProfile(orphan.profile.id), { deleted: false });
  pass("deleteTerminalOnlyProfile removes an unpaired half and refuses a paired one");

  // The mirror stays live for the surviving pairs: a rotation on the terminal
  // side of Work reaches Cora.
  await writeClaudeSlot(workDir, workDir, claudeCredential(30));
  const reconciled = await service.reconcileCliProfile(workCli);
  assert.equal(reconciled.wrote, "pi");
  assert.equal(readPi(work.id).access, "claude-access-30");
  await service.reconcileDefault();
  pass("reconcileCliProfile folds a terminal-side rotation back into Cora");

  // A second machine: no ~/.claude login, several managed accounts. Every
  // hand-off, rollback and race below runs against real stores.
  {
    const HOME2 = path.join(TMP, "home-2");
    const piRoot2 = path.join(HOME2, ".codarastudio", "pi-agent");
    const claudeRoot2 = path.join(HOME2, ".codarastudio", "claude-cli");
    const personalDir2 = path.join(HOME2, ".claude");
    privateDir(personalDir2);
    const piStore2 = new H.piStore.PiAccountAuthStore(piRoot2);
    const leases2 = new H.execution.ClaudeCliProfileLeaseRegistry();
    let cliIndex2 = 0;
    const claudeStore2 = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot2, {
      personalConfigDir: personalDir2,
      personalConfigDirEnv: null,
      leases: leases2,
      idFactory: () => CLI_IDS_2[cliIndex2++],
      authChecker: (input) =>
        H.claudeProfiles.claudeCredentialAuthChecker(input, { backend, personalFallback: null }),
    });
    const mirror2 = new H.mirror.CredentialMirror({
      loadAuthStorage,
      pollWhenWatchBlind: null,
      debounceMs: 30,
      retryDelayMs: 20,
    });
    let networkIdentity2 = {};
    const liveOwners2 = new Set();
    const logs2 = [];
    let deletingCora = null;
    const service2 = new H.accounts.AnthropicAccountService({
      piStore: piStore2,
      claudeStore: claudeStore2,
      leases: leases2,
      mirror: mirror2,
      backend,
      loadAuthStorage,
      readIdentity: async () => networkIdentity2,
      homeDir: HOME2,
      invalidateCaches: async () => undefined,
      sessions: {
        liveOwnerIds: () => liveOwners2,
        disposeProfileSessions: async (profileId) => {
          let count = 0;
          for (const owner of leases2.owners(profileId)) {
            if (owner.startsWith("terminal:")) {
              liveOwners2.delete(owner);
              count += 1;
            }
          }
          // Everything that reconciles concurrently in production: the
          // lease-release hook, the usage poller, a Cora launch.
          void service2.reconcileCliProfile(profileId).catch(() => null);
          if (deletingCora) void service2.reconcileProfile(deletingCora).catch(() => null);
          void service2.reconcileDefault().catch(() => null);
          return { closedSessionCount: count };
        },
      },
      platform: "linux",
      log: (message) => logs2.push(message),
    });
    const managedDir2 = (cliId) =>
      H.claudeProfiles.claudeCliManagedProfileConfigDir(claudeRoot2, cliId);
    const connectCora2 = async (label, n, identity) => {
      const target = await piStore2.prepareCredentialTarget({
        provider: "anthropic",
        label,
        identityFingerprint: identity.fingerprint,
        accountEmail: identity.email,
      });
      const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot2, target.profile.id);
      privateDir(configDir);
      await AuthStorage.create(authFile).modify("anthropic", async () => piCredential(n));
      fs.chmodSync(authFile, 0o600);
      return target.profile;
    };
    const identityA = { fingerprint: fingerprintOf(UUID_A), email: "a@example.com", accountUuid: UUID_A };
    const identityB = { fingerprint: fingerprintOf(UUID_B), email: "b@example.com", accountUuid: UUID_B };
    const identityC = { fingerprint: fingerprintOf(UUID_C), email: "c@example.com", accountUuid: UUID_C };
    const a = await connectCora2("A", 5, identityA);
    const aCli = await service2.ensureCliHalf(a.id, H.claudeCodec.canonicalFromPi(piCredential(5)), identityA);
    const b = await connectCora2("B", 6, identityB);
    const bCli = await service2.ensureCliHalf(b.id, H.claudeCodec.canonicalFromPi(piCredential(6)), identityB);
    await service2.useAccount(a.id);
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, aCli);

    // Deleting the active account with no Account 1 hands both defaults to
    // the oldest remaining account instead of a signed-out ~/.claude.
    assert.deepEqual(await service2.deleteAccount(a.id), { deleted: true, closedSessionCount: 0 });
    assert.equal((await piStore2.registry.snapshot()).defaults.anthropic, b.id);
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, bCli);
    assert.equal(fs.existsSync(managedDir2(aCli)), false);
    pass("deleting the active account hands off to the next connected account when Account 1 is absent");

    // A Cora-only row that is already the default gets its half on
    // reconnect, and the Claude default follows without waiting for a launch.
    const c = await connectCora2("C", 7, identityC);
    await service2.useAccount(c.id);
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, "personal");
    const cCli = await service2.ensureCliHalf(c.id, H.claudeCodec.canonicalFromPi(piCredential(7)), identityC);
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, cCli);
    assert.equal((await piStore2.registry.snapshot()).defaults.anthropic, c.id);
    pass("a half created for the current Cora default takes the Claude Code default with it");

    // A ~/.claude login that belongs to a managed-linked row is derived once,
    // not on every probe tick.
    await writeClaudeSlot(personalDir2, null, claudeCredential(3));
    fs.writeFileSync(
      path.join(HOME2, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: UUID_B, emailAddress: "b@example.com" } }),
      { mode: 0o600 },
    );
    assert.equal(await service2.ensureAccountOne(), null);
    assert.equal(await service2.ensureAccountOne(), null);
    assert.equal(logs2.filter((line) => line.includes("already paired with a managed profile")).length, 1);
    assert.equal((await piStore2.registry.listProfiles()).length, 2);
    await backend.clear(personalDir2, null);
    fs.rmSync(path.join(HOME2, ".claude.json"), { force: true });
    pass("a personal login owned by a managed-linked row is rejected once and remembered");

    // The Pi half refusing mid-delete leaves the row whole and still watched.
    let guardCalls = 0;
    await assert.rejects(
      () =>
        service2.deleteAccount(b.id, {
          ownershipGuard: async () => {
            guardCalls += 1;
            if (guardCalls > 1) throw new Error("run store unreadable");
            return false;
          },
        }),
      /run store unreadable/,
    );
    assert.equal((await piStore2.registry.getProfile(b.id)).cliProfileId, bCli);
    assert.equal(mirror2.pairFor(b.id).cliProfileId, bCli);
    assert.ok(fs.existsSync(managedDir2(bCli)));
    assert.ok(keychain.has(H.credentials.claudeCliKeychainService(managedDir2(bCli))));
    pass("a Pi half that refuses to delete leaves the account whole, never half-deleted");

    // Defaults that drifted apart (Claude on B's half, Cora on C) do not make
    // B undeletable: the Claude default moves to the active row's half.
    await claudeStore2.setDefaultProfile(bCli);
    assert.deepEqual(await service2.deleteAccount(b.id), { deleted: true, closedSessionCount: 0 });
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, cCli);
    assert.equal((await piStore2.registry.snapshot()).defaults.anthropic, c.id);
    assert.equal(fs.existsSync(managedDir2(bCli)), false);
    pass("a drifted Claude Code default is moved off the half being deleted");

    // Reconciles racing the delete of a leased account cannot rebuild the
    // half: the directory and the Keychain item stay gone, and no orphan is
    // left for the store to report.
    leases2.acquire(cCli, "terminal:pane-c");
    liveOwners2.add("terminal:pane-c");
    deletingCora = c.id;
    const deletedC = await service2.deleteAccount(c.id, { closeSessions: true });
    assert.deepEqual(deletedC, { deleted: true, closedSessionCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(managedDir2(cCli)), false);
    assert.equal(keychain.has(H.credentials.claudeCliKeychainService(managedDir2(cCli))), false);
    assert.deepEqual((await claudeStore2.reconcile()).orphanProfileIds, []);
    assert.equal((await piStore2.registry.snapshot()).defaults.anthropic, undefined);
    assert.equal((await claudeStore2.snapshot()).defaultProfileId, "personal");
    assert.equal(await service2.reconcileCliProfile(cCli), null);
    pass("reconciles racing a delete never resurrect the deleted half");

    // Account 1 registered offline (no identity anywhere) learns its
    // fingerprint on a later pass instead of staying unmatchable forever.
    await writeClaudeSlot(personalDir2, null, claudeCredential(2));
    const offlineOne = await service2.ensureAccountOne();
    assert.equal(offlineOne.label, "Account 1");
    assert.equal(offlineOne.identityFingerprint, undefined);
    networkIdentity2 = { fingerprint: fingerprintOf(UUID_A), email: "a@example.com" };
    const learned = await service2.ensureAccountOne();
    assert.equal(learned.id, offlineOne.id);
    assert.equal(learned.identityFingerprint, fingerprintOf(UUID_A));
    assert.equal(learned.accountEmail, "a@example.com");
    assert.equal((await piStore2.registry.listProfiles()).length, 1);
    pass("Account 1 registered without an identity is backfilled once the identity is reachable");

    mirror2.stop();
    service2.stop();
  }

  // Nothing produced by the service is readable by group or other users.
  const offending = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else if (/auth\.json$|\.credentials\.json$|account-profiles\.json$|\.claude\.json$/.test(entry.name) && (mode(file) & 0o077) !== 0) {
        offending.push(file);
      }
    }
  };
  visit(path.join(HOME, ".codarastudio"));
  assert.deepEqual(offending, []);
  pass("every produced file is owner-only");

  mirror.stop();
  service.stop();
  console.log(`\nPASS unified Anthropic account service (${passes} groups)`);
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
