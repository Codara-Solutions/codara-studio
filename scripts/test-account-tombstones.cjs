#!/usr/bin/env node
"use strict";

// Deleted accounts stay deleted (accounts spec 5.5 and I5/I6): after a
// delete and a restart (new registry, stores and services, the whole
// startup pass), a leftover personal-login.json, a legacy pi-agent/auth.json
// or a System login with the same identity brings nothing back. Only an
// explicit add re-registers the account, and that clears the tombstone.
//
//   node scripts/test-account-tombstones.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-tombstones-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;

const SYSTEM_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WORK_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const fingerprintOf = (uuid) => crypto.createHash("sha256").update(uuid.toLowerCase()).digest("hex");
const T0 = Date.now() + 24 * 60 * 60 * 1000;

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as migration from ${JSON.stringify(orchestration("unified-account-migration.ts"))};`,
      `export * as claudeAdapter from ${JSON.stringify(orchestration("account-adapters/claude-account-adapter.ts"))};`,
      `export * as claudeCodec from ${JSON.stringify(orchestration("account-adapters/claude-credential-codec.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
      `export * as codexProfiles from ${JSON.stringify(orchestration("codex-cli-account-profiles.ts"))};`,
      `export * as grokProfiles from ${JSON.stringify(orchestration("grok-cli-account-profiles.ts"))};`,
      `export * as execution from ${JSON.stringify(orchestration("claude-cli-profile-execution.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as liveLogin from ${JSON.stringify(orchestration("claude-cli-live-login.ts"))};`,
      `export * as systemLogin from ${JSON.stringify(orchestration("system-cli-login.ts"))};`,
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
        name: "tombstones-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          const stub = (filter, name, contents) => {
            build.onResolve({ filter }, () => ({ path: name, namespace: "stub" }));
            build.onLoad({ filter: new RegExp(`^${name}$`), namespace: "stub" }, () => ({
              loader: "js",
              contents,
            }));
          };
          stub(/pi-runtime-electron$/, "runtime-electron", `export async function resolveCodaraPiRuntime() { throw new Error("not used"); } export async function resolveCodaraPiLibrary() { throw new Error("not used"); } export async function resolveUserPiRuntime() { throw new Error("not used"); }`);
          stub(/pi-subscription-usage$/, "usage", `export function invalidatePiSubscriptionUsageCache() {}`);
          stub(/pi-model-catalog$/, "catalog", `export function invalidatePiModelCatalogCache() {}`);
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();

  writeJson(path.join(HOME, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "system" } });
  writeJson(path.join(HOME, ".claude.json"), { oauthAccount: { accountUuid: SYSTEM_UUID, emailAddress: "me@example.com" } });

  const piRoot = path.join(CODARA, "pi-agent");
  const claudeRoot = path.join(CODARA, "claude-cli");
  const readSystemLogin = (provider) =>
    H.systemLogin.readSystemLogin(provider, { homeDir: HOME, env: {}, platform: "linux" });

  /** One process lifetime: fresh registry, stores and service. */
  const boot = () => {
    const piStore = new H.piStore.PiAccountAuthStore(piRoot);
    const leases = new H.execution.ClaudeCliProfileLeaseRegistry();
    const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
      personalConfigDir: path.join(HOME, ".claude"),
      personalConfigDirEnv: null,
      leases,
      authChecker: () => ({ connected: true }),
    });
    const service = new H.accounts.UnifiedAccountService(
      H.claudeAdapter.createClaudeAccountAdapter({
        store: claudeStore,
        leases,
        fileOnly: true,
        platform: "linux",
        readIdentity: async () => ({}),
      }),
      {
        piStore,
        mirror: new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 30, retryDelayMs: 20 }),
        loadAuthStorage,
        invalidateCaches: async () => undefined,
        sessions: { liveOwnerIds: () => new Set() },
        readSystemLogin,
      },
    );
    const startupPass = () =>
      H.migration.migrateUnifiedAccounts({
        services: { anthropic: service },
        providers: ["anthropic"],
        piStore,
        claudeStore,
        codexStore: new H.codexProfiles.CodexCliAccountProfileStore(path.join(CODARA, "codex-cli"), {
          personalHomeDir: path.join(HOME, ".codex"),
        }),
        grokStore: new H.grokProfiles.GrokCliAccountProfileStore(path.join(CODARA, "grok-cli"), {
          personalHomeDir: path.join(HOME, ".grok"),
        }),
        codaraHome: CODARA,
        readSystemLogin,
        refreshShellPointer: async () => undefined,
        log: () => undefined,
      });
    return { piStore, claudeStore, service, startupPass };
  };

  // --- Two accounts, then both deleted -----------------------------------------
  let life = boot();
  const system = await life.service.addSystemAccount();
  const work = await life.piStore.prepareCredentialTarget({
    provider: "anthropic",
    label: "Work",
    identityFingerprint: fingerprintOf(WORK_UUID),
  });
  const { authFile } = H.piStore.piAccountProfilePaths(piRoot, work.profile.id);
  await AuthStorage.create(authFile).modify("anthropic", async () => ({
    type: "oauth",
    access: "work-access",
    refresh: "work-refresh",
    expires: T0,
  }));
  const workCli = await life.service.ensureCliHalf(
    work.profile.id,
    H.claudeCodec.canonicalFromPi({ type: "oauth", access: "work-access", refresh: "work-refresh", expires: T0 }),
    { fingerprint: fingerprintOf(WORK_UUID), accountUuid: WORK_UUID },
  );
  await life.service.useAccount(work.profile.id);
  await life.service.deleteAccount(work.profile.id);
  await life.service.deleteAccount(system.id);
  life.service.stop();
  assert.deepEqual(await life.piStore.registry.listProfiles(), []);
  pass("both accounts are deleted");

  // Leftovers an older build could have resurrected from.
  writeJson(path.join(claudeRoot, "personal-login.json"), {
    version: 1,
    store: { claudeAiOauth: { accessToken: "kept", refreshToken: "kept-r", expiresAt: T0 } },
  });
  writeJson(path.join(piRoot, "auth.json"), { anthropic: { type: "oauth", access: "legacy", refresh: "legacy-r", expires: T0 } });
  writeJson(H.liveLogin.claudeCliVaultFile(claudeRoot, workCli), {
    version: 1,
    store: { claudeAiOauth: { accessToken: "stale", refreshToken: "stale-r", expiresAt: T0 } },
    oauthAccount: { accountUuid: WORK_UUID },
  });

  // --- Restart --------------------------------------------------------------
  for (let restart = 0; restart < 2; restart += 1) {
    life = boot();
    const report = await life.startupPass();
    assert.equal(report.failedStep, null);
    assert.deepEqual(await life.piStore.registry.listProfiles(), [], `restart ${restart + 1}`);
    assert.deepEqual((await life.piStore.inspect()).snapshot.profiles, []);
    assert.equal(await life.service.systemOffer(), null, "the System login with the deleted identity is not offered again");
    assert.equal((await life.claudeStore.snapshot()).profiles.some((profile) => profile.id === workCli), false);
    assert.deepEqual((await life.service.listAccounts()).accounts, []);
    life.service.stop();
  }
  pass("restarts with leftover logins and the same System identity resurrect nothing");

  // --- Only an explicit add brings an identity back -----------------------------
  life = boot();
  await assert.rejects(
    () => life.piStore.registry.registerProfile({ provider: "anthropic", label: "Again", identityFingerprint: fingerprintOf(WORK_UUID) }),
    { name: "PiAccountProfileTombstonedError" },
  );
  await assert.rejects(
    () => life.piStore.registry.registerProfile({ provider: "anthropic", label: "Me", identityFingerprint: fingerprintOf(SYSTEM_UUID) }),
    { name: "PiAccountProfileTombstonedError" },
  );
  const readded = await life.service.addSystemAccount();
  assert.equal(readded.identityFingerprint, fingerprintOf(SYSTEM_UUID));
  assert.equal(await life.piStore.registry.isTombstoned("anthropic", { identityFingerprint: fingerprintOf(SYSTEM_UUID) }), false);
  assert.equal(await life.piStore.registry.isTombstoned("anthropic", { identityFingerprint: fingerprintOf(WORK_UUID) }), true,
    "another identity's tombstone stays");
  const again = await life.piStore.prepareCredentialTarget({
    provider: "anthropic",
    label: "Work again",
    identityFingerprint: fingerprintOf(WORK_UUID),
  });
  assert.ok(again.profile.id, "signing in through Add account is an explicit add");
  assert.equal(await life.piStore.registry.isTombstoned("anthropic", { identityFingerprint: fingerprintOf(WORK_UUID) }), false);
  life.service.stop();
  pass("an explicit add re-registers a deleted identity and clears only its tombstone");

  console.log(`\nPASS account tombstones (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
