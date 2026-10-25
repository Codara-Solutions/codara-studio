#!/usr/bin/env node
"use strict";

// The startup pass over all three providers, against real temp roots, real
// account services and the REAL pinned Pi AuthStorage: the accounts v2
// migration runs first, then per provider clear-dangling-links,
// project-defaults, purge-deleted-homes and start-mirror, then the shell
// pointer. A failing step does not block the others, the ready gate
// resolves after a failure, a second pass writes nothing, and no step adds
// an account or touches the user's CLI homes.
//
//   node scripts/test-unified-account-migration.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-unified-migration-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const MAIN_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CODEX_WORK = "acct-22222222-2222-4222-8222-222222222222";
const CLAUDE_MAIN = "bd5882bc-0000-4000-8000-000000000011";
const CODEX_WORK_CLI = "224c686d-0000-4000-8000-000000000022";
const ROW_MAIN = "f7ef8f54-0000-4000-8000-000000000001";
const ROW_CODEX = "a0000000-0000-4000-8000-000000000006";
const DAY = 24 * 60 * 60 * 1000;

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as migration from ${JSON.stringify(orchestration("unified-account-migration.ts"))};`,
      `export * as claudeAdapter from ${JSON.stringify(orchestration("account-adapters/claude-account-adapter.ts"))};`,
      `export * as codexAdapter from ${JSON.stringify(orchestration("account-adapters/codex-account-adapter.ts"))};`,
      `export * as grokAdapter from ${JSON.stringify(orchestration("account-adapters/grok-account-adapter.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
      `export * as claudeExecution from ${JSON.stringify(orchestration("claude-cli-profile-execution.ts"))};`,
      `export * as codexProfiles from ${JSON.stringify(orchestration("codex-cli-account-profiles.ts"))};`,
      `export * as codexExecution from ${JSON.stringify(orchestration("codex-cli-profile-execution.ts"))};`,
      `export * as grokProfiles from ${JSON.stringify(orchestration("grok-cli-account-profiles.ts"))};`,
      `export * as grokExecution from ${JSON.stringify(orchestration("grok-cli-profile-execution.ts"))};`,
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
        name: "unified-migration-harness",
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
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function snapshotTree(dir) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) entries.push(`${path.relative(dir, file)} -> ${fs.readlinkSync(file)}`);
      else if (entry.isDirectory()) visit(file);
      else entries.push(`${path.relative(dir, file)}:${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf8")}`);
    }
  };
  visit(dir);
  return entries.join("\n");
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();

  // The System logins.
  writeJson(path.join(HOME, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "system" } });
  writeJson(path.join(HOME, ".claude.json"), { oauthAccount: { accountUuid: MAIN_UUID, emailAddress: "main@example.com" } });
  fs.mkdirSync(path.join(HOME, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".grok"), { recursive: true });
  const systemBefore = () =>
    [".claude", ".codex", ".grok"].map((name) => snapshotTree(path.join(HOME, name))).join("\n#\n") +
    fs.readFileSync(path.join(HOME, ".claude.json"), "utf8");
  const ownBefore = systemBefore();

  // Stores and services.
  const piRoot = path.join(CODARA, "pi-agent");
  const claudeRoot = path.join(CODARA, "claude-cli");
  const codexRoot = path.join(CODARA, "codex-cli");
  const grokRoot = path.join(CODARA, "grok-cli");
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const claudeLeases = new H.claudeExecution.ClaudeCliProfileLeaseRegistry();
  const codexLeases = new H.codexExecution.CodexCliProfileLeaseRegistry();
  const grokLeases = new H.grokExecution.GrokCliProfileLeaseRegistry();
  const claudeIds = [CLAUDE_MAIN];
  const codexIds = [CODEX_WORK_CLI];
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: path.join(HOME, ".claude"),
    personalConfigDirEnv: null,
    leases: claudeLeases,
    idFactory: () => claudeIds.shift(),
    authChecker: () => ({ connected: true }),
  });
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: path.join(HOME, ".codex"),
    leases: codexLeases,
    idFactory: () => codexIds.shift(),
  });
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: path.join(HOME, ".grok"),
    leases: grokLeases,
  });
  const readSystemLogin = (provider) =>
    H.systemLogin.readSystemLogin(provider, { homeDir: HOME, env: {}, platform: "linux" });
  const common = (log) => ({
    piStore,
    mirror: new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 30, retryDelayMs: 20 }),
    loadAuthStorage,
    invalidateCaches: async () => undefined,
    sessions: { liveOwnerIds: () => new Set() },
    readSystemLogin,
    log,
  });
  const logs = [];
  const log = (message) => logs.push(message);
  const services = {
    anthropic: new H.accounts.UnifiedAccountService(
      H.claudeAdapter.createClaudeAccountAdapter({
        store: claudeStore,
        leases: claudeLeases,
        fileOnly: true,
        platform: "linux",
        readIdentity: async () => ({}),
      }),
      common(log),
    ),
    "openai-codex": new H.accounts.UnifiedAccountService(
      H.codexAdapter.createCodexAccountAdapter({ store: codexStore, leases: codexLeases }),
      common(log),
    ),
    xai: new H.accounts.UnifiedAccountService(
      H.grokAdapter.createGrokAccountAdapter({ store: grokStore, leases: grokLeases }),
      common(log),
    ),
  };

  // A v1 machine: Claude Main moved into ~/.claude, a Codex account vaulted.
  await claudeStore.createProfile({ label: "Main" });
  await codexStore.createProfile({ label: "Work" });
  writeJson(path.join(claudeRoot, "live-login.json"), { version: 1, profileId: CLAUDE_MAIN });
  writeJson(H.liveLogin.claudeCliVaultFile(claudeRoot, CLAUDE_MAIN), {
    version: 1,
    store: { claudeAiOauth: { accessToken: "old", refreshToken: "old-r", expiresAt: Date.now() - DAY } },
  });
  const workAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: CODEX_WORK } });
  const workAuth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ email: "work@example.com" }), access_token: workAccess, refresh_token: "work-r", account_id: CODEX_WORK },
  };
  writeJson(path.join(codexRoot, "accounts", CODEX_WORK_CLI, "auth.json"), workAuth);
  fs.rmSync(path.join(codexRoot, "accounts", CODEX_WORK_CLI, "home", "auth.json"), { force: true });
  const writePi = async (row, provider, credential) => {
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, row);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    await AuthStorage.create(authFile).modify(provider, async () => credential);
    fs.chmodSync(authFile, 0o600);
  };
  await writePi(ROW_MAIN, "anthropic", { type: "oauth", access: "main-cora", refresh: "main-cora-r", expires: Date.now() + DAY });
  await writePi(ROW_CODEX, "openai-codex", { type: "oauth", access: workAccess, refresh: "work-r", expires: Date.now() + 3_000_000, accountId: CODEX_WORK });
  const at = "2026-01-01T00:00:00.000Z";
  writeJson(path.join(piRoot, "account-profiles.json"), {
    version: 1,
    profiles: [
      { id: ROW_MAIN, provider: "anthropic", label: "Main", createdAt: at, updatedAt: at, identityFingerprint: sha(MAIN_UUID), cliProfileId: CLAUDE_MAIN },
      { id: ROW_CODEX, provider: "openai-codex", label: "Work", createdAt: at, updatedAt: at, identityFingerprint: sha(CODEX_WORK), cliProfileId: CODEX_WORK_CLI },
    ],
    defaults: { anthropic: ROW_MAIN, "openai-codex": ROW_CODEX },
  });

  // Every step is recorded in order; the migration must have committed
  // before the first per-provider step runs.
  const order = [];
  for (const [provider, service] of Object.entries(services)) {
    for (const name of ["clearDanglingLinks", "reprojectDefaults", "purgePending", "startMirror"]) {
      const original = service[name].bind(service);
      service[name] = async (...args) => {
        if (order.length === 0) {
          assert.equal(await piStore.registry.needsMigration(), false, "the v2 migration ran first");
        }
        order.push(`${provider}:${name}`);
        return original(...args);
      };
    }
  }
  let pointerWrites = 0;
  const deps = {
    services,
    piStore,
    claudeStore,
    codexStore,
    grokStore,
    codaraHome: CODARA,
    readSystemLogin,
    refreshShellPointer: async () => {
      order.push("shell-pointer");
      pointerWrites += 1;
    },
    log,
  };

  // --- First pass ------------------------------------------------------------
  const first = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(first.failedStep, null, JSON.stringify(logs));
  assert.equal(first.accountsV2.migrated, true);
  assert.deepEqual(first.accountsV2.cases, { [ROW_MAIN]: "system", [ROW_CODEX]: "managed" });
  const steps = ["clearDanglingLinks", "reprojectDefaults", "purgePending", "startMirror"];
  assert.deepEqual(order, [
    ...steps.map((step) => `anthropic:${step}`),
    ...steps.map((step) => `openai-codex:${step}`),
    ...steps.map((step) => `xai:${step}`),
    "shell-pointer",
  ]);
  pass("the v2 migration runs first, then each provider's steps in order, then the shell pointer");

  // What the pass settled.
  assert.equal((await claudeStore.snapshot()).defaultProfileId, "personal", "Main is on the System login");
  assert.equal((await codexStore.snapshot()).defaultProfileId, CODEX_WORK_CLI, "the Codex Active row is projected");
  assert.equal(readJson(H.codexProfiles.codexCliManagedProfilePaths(codexRoot, CODEX_WORK_CLI).authFile).tokens.refresh_token, "work-r");
  assert.equal(first.providers["openai-codex"].watchedPairs, 1);
  assert.equal(first.providers.anthropic.watchedPairs, 0, "a System row is never mirrored");
  assert.deepEqual(
    (await piStore.registry.listProfiles()).map((profile) => profile.id).sort(),
    [ROW_MAIN, ROW_CODEX].sort(),
    "the pass adds no account",
  );
  assert.equal(systemBefore(), ownBefore, "the user's CLI homes are untouched");
  pass("the pass projects the Active rows, mirrors only managed pairs and adds no account");

  // --- Second pass: nothing to write ----------------------------------------
  for (const service of Object.values(services)) service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const codaraBefore = snapshotTree(CODARA);
  order.length = 0;
  const second = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(second.failedStep, null);
  assert.equal(second.accountsV2.migrated, false);
  for (const service of Object.values(services)) service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(snapshotTree(CODARA), codaraBefore, "a second pass writes nothing under Codara's home");
  pass("a second pass writes nothing");

  // --- A vanished half and a home left to purge -----------------------------
  const codexPaths = H.codexProfiles.codexCliManagedProfilePaths(codexRoot, CODEX_WORK_CLI);
  await codexStore.setDefaultProfile("personal");
  await codexStore.deleteProfile(CODEX_WORK_CLI, { keepDirectory: true });
  await piStore.registry.queuePendingPurge([{ path: codexPaths.profileDir, reason: "codex terminal still running" }]);
  order.length = 0;
  const third = await H.migration.migrateUnifiedAccounts(deps);
  assert.deepEqual(third.providers["openai-codex"].clearedLinks, [ROW_CODEX]);
  assert.deepEqual(third.providers["openai-codex"].purged, [codexPaths.profileDir]);
  assert.equal(fs.existsSync(codexPaths.profileDir), false);
  const codexRow = await piStore.registry.getProfile(ROW_CODEX);
  assert.deepEqual([codexRow.cli, codexRow.cora], [{ kind: "none" }, "own"], "the row keeps its Cora grant as its own");
  for (const service of Object.values(services)) service.stop();
  pass("a vanished managed half is unlinked and a queued home is purged");

  // --- A failing step does not block the rest, and the gate resolves --------
  const grokClear = services.xai.clearDanglingLinks;
  services.xai.clearDanglingLinks = async () => {
    throw new Error("grok store unreadable");
  };
  const anthropicMirror = services.anthropic.startMirror;
  services.anthropic.startMirror = async () => {
    throw new Error("watch limit");
  };
  order.length = 0;
  logs.length = 0;
  const failing = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(failing.failedStep, "anthropic:start-mirror");
  assert.equal(failing.providers.xai.failedStep, "xai:clear-dangling-links");
  assert.ok(order.includes("openai-codex:startMirror"), "Codex still ran after Claude failed");
  assert.ok(order.includes("xai:purgePending"), "Grok's later steps still ran");
  assert.equal(order.at(-1), "shell-pointer");
  assert.ok(logs.some((line) => /grok store unreadable/.test(line)));
  for (const service of Object.values(services)) service.stop();

  H.migration.resetUnifiedAccountMigrationForTests();
  const pointerBefore = pointerWrites;
  services.xai.clearDanglingLinks = async () => {
    throw new Error("still broken");
  };
  await H.migration.startUnifiedAccountMigration(deps);
  await H.migration.unifiedAccountsReady();
  assert.equal(pointerWrites, pointerBefore + 1, "the gate resolved after the whole pass, failure included");
  services.xai.clearDanglingLinks = grokClear;
  services.anthropic.startMirror = anthropicMirror;
  for (const service of Object.values(services)) service.stop();
  H.migration.resetUnifiedAccountMigrationForTests();
  pass("a failing step is logged and skipped, and the ready gate still resolves");

  assert.equal(systemBefore(), ownBefore, "the user's CLI homes are untouched by every pass");
  pass("no pass touches the user's CLI homes");

  console.log(`\nPASS unified account startup pass (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
