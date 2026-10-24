#!/usr/bin/env node
"use strict";

// The unified Anthropic account service against real temp roots: a real Pi
// account store and registry, a real Claude Code account store with Codara's
// live slot, the real credential mirror and the REAL pinned Pi AuthStorage.
// Only the Keychain (off: the slot's store is its `.credentials.json`), the
// network identity lookup and the terminal session table are stubbed. HOME
// is a fake home whose ~/.claude is the System login; nothing in it may
// change.
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
process.env.HOME = HOME;
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
const SYSTEM_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WORK_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const HOME_UUID = "c3333333-3333-4333-8333-333333333333";
const fingerprintOf = (uuid) => crypto.createHash("sha256").update(uuid.toLowerCase()).digest("hex");
const PADDING = 5 * 60 * 1000;
const T0 = 1_900_000_000_000;

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as claudeAdapter from ${JSON.stringify(orchestration("account-adapters/claude-account-adapter.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
      `export * as execution from ${JSON.stringify(orchestration("claude-cli-profile-execution.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as claudeCodec from ${JSON.stringify(orchestration("account-adapters/claude-credential-codec.ts"))};`,
      `export * as liveLogin from ${JSON.stringify(orchestration("claude-cli-live-login.ts"))};`,
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
            contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); } export async function resolveCodaraPiLibrary() { throw new Error("not used"); } export async function resolveUserPiRuntime() { throw new Error("not used"); }`,
          }));
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

function writeJson(file, value) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
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

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();

  // The System login: the user's own ~/.claude, signed in as SYSTEM_UUID.
  const systemDir = path.join(HOME, ".claude");
  writeJson(path.join(systemDir, ".credentials.json"), {
    claudeAiOauth: { accessToken: "system-access", refreshToken: "system-refresh", expiresAt: T0 },
  });
  privateDir(path.join(systemDir, "projects"));
  writeJson(path.join(HOME, ".claude.json"), {
    oauthAccount: { accountUuid: SYSTEM_UUID, emailAddress: "me@example.com" },
    projects: { "/work": { hasTrustDialogAccepted: true } },
    mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } },
  });
  const systemBefore = () => {
    const tree = snapshotTree(systemDir);
    tree[".claude.json"] = fs.readFileSync(path.join(HOME, ".claude.json"), "utf8");
    return tree;
  };
  const ownBefore = systemBefore();

  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const claudeRoot = path.join(HOME, ".codarastudio", "claude-cli");
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.ClaudeCliProfileLeaseRegistry();
  let cliIndex = 0;
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: systemDir,
    personalConfigDirEnv: null,
    leases,
    idFactory: () => CLI_IDS[cliIndex++],
    authChecker: (input) => H.claudeProfiles.claudeCredentialAuthChecker(input, { liveFallback: null }),
  });
  const liveFile = path.join(claudeStore.liveConfigDir, ".credentials.json");
  const liveConfig = path.join(claudeStore.liveConfigDir, ".claude.json");
  const vaultFile = (cliId) => H.liveLogin.claudeCliVaultFile(claudeRoot, cliId);
  const liveId = () => H.liveLogin.readClaudeLiveProfileId(claudeRoot);
  let networkIdentity = {};
  let broadcasts = 0;
  const liveOwners = new Set();
  const logs = [];
  const makeService = () =>
    new H.accounts.UnifiedAccountService(
      H.claudeAdapter.createClaudeAccountAdapter({
        store: claudeStore,
        leases,
        fileOnly: true,
        readIdentity: async () => networkIdentity,
        platform: "linux",
        log: (message) => logs.push(message),
      }),
      {
        piStore,
        mirror: new H.mirror.CredentialMirror({
          loadAuthStorage,
          pollWhenWatchBlind: null,
          debounceMs: 30,
          retryDelayMs: 20,
        }),
        loadAuthStorage,
        invalidateCaches: async () => undefined,
        broadcast: () => {
          broadcasts += 1;
        },
        sessions: { liveOwnerIds: () => liveOwners },
        log: (message) => logs.push(message),
      },
    );
  let service = makeService();

  const piCredential = (n) => ({
    type: "oauth",
    access: `pi-access-${n}`,
    refresh: `pi-refresh-${n}`,
    expires: T0 + n * 1000 - PADDING,
  });
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) => readJson(piAuthFile(coraId))?.anthropic ?? null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(authFile).modify("anthropic", async () => credential);
    fs.chmodSync(authFile, 0o600);
  };
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
  const defaults = async () => (await piStore.registry.snapshot()).defaults.anthropic;

  // --- The System login is offered, never adopted ----------------------------
  assert.deepEqual(await piStore.registry.listProfiles(), []);
  assert.deepEqual((await service.listAccounts()).accounts, []);
  assert.deepEqual(await service.systemOffer(), { email: "me@example.com" });
  assert.deepEqual(await piStore.registry.listProfiles(), [], "an offer registers nothing");
  pass("a signed-in System login is offered as one line and never registered on its own");

  // Use in Codara: a row on the System login, Cora not connected yet.
  const system = await service.addSystemAccount();
  assert.equal(system.cli.kind, "system");
  assert.equal(system.cliProfileId, "personal");
  assert.equal(system.cora, "none");
  assert.equal(system.label, "me@example.com");
  assert.equal(system.identityFingerprint, fingerprintOf(SYSTEM_UUID));
  assert.equal(readPi(system.id), null, "nothing of the System login is copied to Cora");
  assert.equal(await service.systemOffer(), null, "the offer goes once the row exists");
  assert.equal((await service.addSystemAccount()).id, system.id, "adding it again is idempotent");
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal(fs.existsSync(liveFile), false, "the live slot is untouched");
  pass("Use in Codara adds a System row without reading or copying its login");

  // --- A Cora sign-in grows a managed half -----------------------------------
  networkIdentity = {
    fingerprint: fingerprintOf(WORK_UUID),
    email: "work@example.com",
    accountUuid: WORK_UUID,
    organizationUuid: "org-work",
  };
  const work = await connectCora("Work", 5, networkIdentity);
  const workCli = await service.ensureCliHalf(
    work.id,
    H.claudeCodec.canonicalFromPi(piCredential(5)),
    networkIdentity,
  );
  assert.equal(workCli, CLI_IDS[0]);
  const workVault = readJson(vaultFile(workCli));
  assert.equal(workVault.store.claudeAiOauth.accessToken, "pi-access-5");
  assert.equal(workVault.store.claudeAiOauth.expiresAt, T0 + 5000);
  assert.deepEqual(workVault.oauthAccount, {
    accountUuid: WORK_UUID,
    emailAddress: "work@example.com",
    organizationUuid: "org-work",
  });
  const workRow = await piStore.registry.getProfile(work.id);
  assert.equal(workRow.cliProfileId, workCli);
  assert.equal(workRow.cora, "linked");
  assert.equal(fs.existsSync(liveFile), false, "a new half that is not Active never touches the slot");
  assert.equal(await service.ensureCliHalf(work.id, H.claudeCodec.canonicalFromPi(piCredential(5))), workCli);
  assert.equal(await service.ensureCliHalf(system.id, H.claudeCodec.canonicalFromPi(piCredential(5))), null,
    "a System row never gets a managed half");
  pass("a Cora sign-in writes the Claude Code half as a vault in Codara's home");

  // A failure while building the half leaves no directory and no link.
  const fragile = await connectCora("Fragile", 3);
  const fragileService = makeService();
  fragileService.adapter.writeCli = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(
    () => fragileService.ensureCliHalf(fragile.id, H.claudeCodec.canonicalFromPi(piCredential(3))),
    /disk full/,
  );
  assert.equal((await piStore.registry.getProfile(fragile.id)).cliProfileId, undefined);
  assert.equal(fs.existsSync(path.dirname(vaultFile(CLI_IDS[1]))), false);
  assert.equal((await claudeStore.snapshot()).profiles.some((entry) => entry.id === CLI_IDS[1]), false);
  pass("a failed Claude Code half is rolled back and the row stays a shareable half");

  // --- Use: the hot swap ------------------------------------------------------
  broadcasts = 0;
  await service.useAccount(work.id);
  assert.equal(await defaults(), work.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, workCli);
  assert.equal(await liveId(), workCli);
  assert.equal(readJson(liveFile).claudeAiOauth.accessToken, "pi-access-5");
  assert.equal(readJson(liveConfig).oauthAccount.accountUuid, WORK_UUID);
  assert.deepEqual(readJson(liveConfig).mcpServers, { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" } },
    "the slot starts with the user's MCP servers");
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(path.join(claudeStore.liveConfigDir, "projects")), path.join(systemDir, "projects"),
      "shared state links into the user's own Claude home");
  }
  const resolvedWork = await claudeStore.resolveProfile({ useDefault: true });
  assert.equal(resolvedWork.configDirEnv, claudeStore.liveConfigDir, "new terminals run in the live slot");
  assert.ok(broadcasts >= 1);

  networkIdentity = { fingerprint: fingerprintOf(HOME_UUID), email: "home@example.com", accountUuid: HOME_UUID };
  const homeRow = await connectCora("Home", 7, networkIdentity);
  const homeCli = await service.ensureCliHalf(homeRow.id, H.claudeCodec.canonicalFromPi(piCredential(7)), networkIdentity);
  // Claude Code refreshed Work in the slot; the swap saves that generation.
  writeJson(liveFile, { ...readJson(liveFile), claudeAiOauth: { ...readJson(liveFile).claudeAiOauth, accessToken: "work-refreshed", refreshToken: "work-refresh-2" } });
  await service.useAccount(homeRow.id);
  assert.equal(await liveId(), homeCli);
  assert.equal(readJson(liveFile).claudeAiOauth.accessToken, "pi-access-7");
  assert.equal(readJson(liveConfig).oauthAccount.accountUuid, HOME_UUID);
  assert.equal(readJson(vaultFile(workCli)).store.claudeAiOauth.accessToken, "work-refreshed");
  pass("Use swaps the login in the live slot, saving the outgoing account's refreshed login");

  // The System login: new terminals run without the slot, which keeps its
  // account for the sessions already running in it.
  await service.useAccount(system.id);
  assert.equal(await defaults(), system.id);
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal(await liveId(), homeCli, "running managed sessions keep their account");
  const resolvedSystem = await claudeStore.resolveProfile({ useDefault: true });
  assert.equal(resolvedSystem.profileId, "personal");
  assert.equal(resolvedSystem.configDirEnv, null, "the System login means no CLAUDE_CONFIG_DIR");
  await service.useAccount(homeRow.id);
  pass("using the System login sets no variable and leaves the live slot alone");

  // --- Delete -------------------------------------------------------------------
  await assert.rejects(
    () => service.deleteAccount(work.id, { ownershipGuard: async () => true }),
    /protected|active/i,
  );
  assert.ok(await piStore.registry.getProfile(work.id), "a guarded delete changes nothing");

  // A Claude half holds no sessions in its own directory, so even a leased
  // one is purged at once.
  liveOwners.add("terminal:pane-1");
  const releaseLease = leases.acquire(workCli, "terminal:pane-1");
  const deleted = await service.deleteAccount(work.id);
  assert.deepEqual(deleted, { deleted: true, purgePending: false });
  releaseLease();
  liveOwners.clear();
  assert.equal(await piStore.registry.getProfile(work.id), null);
  assert.equal(fs.existsSync(path.dirname(vaultFile(workCli))), false, "the vault directory is purged");
  assert.equal(fs.existsSync(path.dirname(piAuthFile(work.id))), false, "Cora's grant is gone");
  assert.ok((await piStore.registry.snapshot()).tombstones.some((entry) => entry.identityFingerprint === fingerprintOf(WORK_UUID)));
  assert.equal(await liveId(), homeCli, "deleting an account that is not live leaves the slot alone");

  // Deleting the Active account: no hand-off, the System login takes over.
  const deletedActive = await service.deleteAccount(homeRow.id);
  assert.equal(deletedActive.deleted, true);
  assert.equal(await defaults(), undefined, "no other account is promoted");
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal");
  assert.equal(await liveId(), null, "the slot no longer holds the deleted login");
  assert.equal(readJson(liveFile)?.claudeAiOauth, undefined);
  pass("delete purges both halves, tombstones the account and never hands the slot to another account");

  // An interrupted delete: emptying the live slot throws, so the Claude Code
  // store still lists the half and the slot still holds its login. The
  // tombstone wins anyway: no terminal-only card, and the next boot finishes.
  const flakyIdentity = { fingerprint: fingerprintOf("f1111111-1111-4111-8111-111111111111"), email: "flaky@example.com" };
  networkIdentity = flakyIdentity;
  const flaky = await connectCora("Flaky", 11, flakyIdentity);
  const flakyCli = await service.ensureCliHalf(flaky.id, H.claudeCodec.canonicalFromPi(piCredential(11)), flakyIdentity);
  await service.useAccount(flaky.id);
  assert.equal(await liveId(), flakyCli);
  const releaseActive = service.adapter.releaseActive;
  service.adapter.releaseActive = async () => {
    throw new Error("slot busy");
  };
  const interrupted = await service.deleteAccount(flaky.id);
  service.adapter.releaseActive = releaseActive;
  assert.deepEqual(interrupted, { deleted: true, purgePending: true });
  assert.ok((await claudeStore.snapshot()).profiles.some((entry) => entry.id === flakyCli), "the throw left the store entry");
  assert.equal(await liveId(), flakyCli, "the throw left the login in the slot");
  assert.equal((await service.listAccounts()).terminalOnly.some((card) => card.cliProfileId === flakyCli), false,
    "a half queued for purge is never offered as a terminal-only card");

  // The same when deleting the store entry itself throws.
  const shakyIdentity = { fingerprint: fingerprintOf("e2222222-2222-4222-8222-222222222222"), email: "shaky@example.com" };
  networkIdentity = shakyIdentity;
  const shaky = await connectCora("Shaky", 12, shakyIdentity);
  const shakyCli = await service.ensureCliHalf(shaky.id, H.claudeCodec.canonicalFromPi(piCredential(12)), shakyIdentity);
  const deleteProfile = claudeStore.deleteProfile;
  claudeStore.deleteProfile = async () => {
    throw new Error("store locked");
  };
  assert.equal((await service.deleteAccount(shaky.id)).purgePending, true);
  claudeStore.deleteProfile = deleteProfile;
  assert.ok((await claudeStore.snapshot()).profiles.some((entry) => entry.id === shakyCli));
  assert.equal((await service.listAccounts()).terminalOnly.some((card) => card.cliProfileId === shakyCli), false);
  pass("an interrupted delete leaves no terminal-only card behind");

  // --- Restart: nothing comes back --------------------------------------------
  service.stop();
  service = makeService();
  await service.clearDanglingLinks();
  await service.reprojectDefaults();
  await service.purgePending();
  const cliIds = (await claudeStore.snapshot()).profiles.map((entry) => entry.id);
  assert.equal(cliIds.includes(flakyCli), false, "the boot purge removes the store entry an interrupted delete left");
  assert.equal(cliIds.includes(shakyCli), false);
  assert.equal(await liveId(), null, "and empties the slot that still held the deleted login");
  assert.equal(fs.existsSync(path.dirname(vaultFile(flakyCli))), false);
  assert.equal(fs.existsSync(path.dirname(vaultFile(shakyCli))), false);
  assert.deepEqual((await piStore.registry.snapshot()).pendingPurge, [], "nothing stays queued once it is done");
  const ids = (await piStore.registry.listProfiles()).map((profile) => profile.id).sort();
  assert.deepEqual(ids, [fragile.id, system.id].sort(), "deleted accounts stay deleted across a restart");
  await assert.rejects(
    () => piStore.registry.registerProfile({ provider: "anthropic", label: "Back", identityFingerprint: fingerprintOf(WORK_UUID) }),
    { name: "PiAccountProfileTombstonedError" },
  );
  const again = await connectCora("Work again", 9, { fingerprint: fingerprintOf(WORK_UUID) });
  assert.ok(again.id, "signing in again through Add account is the explicit add that brings it back");
  pass("a restart resurrects nothing, and only an explicit add re-registers a deleted account");

  // Deleting the System row leaves the System login itself alone and hides
  // its offer.
  await service.deleteAccount(system.id);
  assert.equal(await service.systemOffer(), null, "a deleted System row's offer stays hidden");
  pass("deleting the System row only forgets it");

  // --- The user's own Claude home -------------------------------------------
  assert.deepEqual(systemBefore(), ownBefore, "~/.claude and ~/.claude.json are byte-for-byte unchanged");
  pass("the user's own Claude home is never written");

  console.log(`\nPASS Anthropic accounts (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
