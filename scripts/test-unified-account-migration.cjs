#!/usr/bin/env node
"use strict";

// The one startup pass over all three providers, against real temp roots
// and the REAL pinned Pi AuthStorage: per-provider ordering, a failing Grok
// undo that does not block Codex pairing, a ready gate that resolves after a
// failure, and no writes on a second run over all three roots.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-unified-migration-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
process.env.CODARA_DISABLE_KEYCHAIN = "1";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

const T0 = 1_900_000_000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const CLAUDE_UUID = "11111111-2222-4333-8444-555555555555";
const CODEX_ACCOUNT = "acct-codex-1111";
const GROK_SUBJECT = "22222222-2222-4222-8222-222222222222";
const GROK_MANAGED = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const GROK_SLOT = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as migration from ${JSON.stringify(orchestration("unified-account-migration.ts"))};`,
      `export * as registry from ${JSON.stringify(orchestration("unified-account-registry.ts"))};`,
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
      `export * as credentials from ${JSON.stringify(orchestration("claude-cli-credentials.ts"))};`,
      `export * as claudeRuntime from ${JSON.stringify(orchestration("native-claude-profile-runtime.ts"))};`,
      `export * as codexRuntime from ${JSON.stringify(orchestration("native-codex-profile-runtime.ts"))};`,
      `export * as grokRuntime from ${JSON.stringify(orchestration("native-grok-profile-runtime.ts"))};`,
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
          stub(/pi-runtime-electron$/, "runtime-electron", `export async function resolveCodaraPiRuntime() { throw new Error("not used"); }`);
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

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function privateFile(file, content) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function snapshotTree(dir) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push(`${path.relative(dir, file)} -> ${fs.readlinkSync(file)}`);
      } else if (entry.isDirectory()) {
        visit(file);
      } else {
        entries.push(`${path.relative(dir, file)}:${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf8")}`);
      }
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
  const codaraHome = path.join(HOME, ".codarastudio");
  const piRoot = path.join(codaraHome, "pi-agent");
  const claudeRoot = path.join(codaraHome, "claude-cli");
  const codexRoot = path.join(codaraHome, "codex-cli");
  const grokRoot = path.join(codaraHome, "grok-cli");
  const claudeHome = path.join(HOME, ".claude");
  const codexHome = path.join(HOME, ".codex");
  const grokHome = path.join(HOME, ".grok");
  for (const dir of [claudeHome, codexHome, grokHome]) privateDir(dir);

  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const claudeLeases = new H.claudeExecution.ClaudeCliProfileLeaseRegistry();
  const claudeStore = new H.claudeProfiles.ClaudeCliAccountProfileStore(claudeRoot, {
    personalConfigDir: claudeHome,
    personalConfigDirEnv: null,
    leases: claudeLeases,
    authChecker: (input) =>
      H.claudeProfiles.claudeCredentialAuthChecker(input, {
        backend: H.credentials.fileOnlyClaudeCliCredentialBackend,
        personalFallback: null,
      }),
  });
  const codexLeases = new H.codexExecution.CodexCliProfileLeaseRegistry();
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: codexHome,
    leases: codexLeases,
  });
  const grokLeases = new H.grokExecution.GrokCliProfileLeaseRegistry();
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: grokHome,
    leases: grokLeases,
  });
  const mirror = new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 30, retryDelayMs: 20 });
  const logs = [];
  const log = (message) => logs.push(message);
  const common = { piStore, mirror, loadAuthStorage, invalidateCaches: async () => undefined, log };
  const services = {
    anthropic: new H.accounts.UnifiedAccountService(
      H.claudeAdapter.createClaudeAccountAdapter({
        store: claudeStore,
        leases: claudeLeases,
        backend: H.credentials.fileOnlyClaudeCliCredentialBackend,
        readIdentity: async () => ({}),
        homeDir: HOME,
        platform: "linux",
      }),
      common,
    ),
    "openai-codex": new H.accounts.UnifiedAccountService(
      H.codexAdapter.createCodexAccountAdapter({ store: codexStore, leases: codexLeases, loadAuthStorage, externalSessionCount: () => 0 }),
      common,
    ),
    xai: new H.accounts.UnifiedAccountService(
      H.grokAdapter.createGrokAccountAdapter({ store: grokStore, leases: grokLeases }),
      common,
    ),
  };
  const deps = {
    services,
    piStore,
    claudeStore,
    backend: H.credentials.fileOnlyClaudeCliCredentialBackend,
    codexStore,
    grokStore,
    log,
  };

  // The layout: a personal login for every CLI, a retired Grok live-slot
  // vault, a legacy pi-agent/auth.json with an xai credential.
  privateFile(
    path.join(claudeHome, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-access-1", refreshToken: "claude-refresh-1", expiresAt: T0 * 1000 + 1000, scopes: ["user:inference"] } }),
  );
  privateFile(path.join(HOME, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: CLAUDE_UUID, emailAddress: "claude@example.com" } }));
  const codexAccess = jwt({ iat: T0, exp: T0 + 240 * 3600, "https://api.openai.com/auth": { chatgpt_account_id: CODEX_ACCOUNT } });
  privateFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ iat: T0, exp: T0 + 3600, email: "codex@example.com" }), access_token: codexAccess, refresh_token: "codex-refresh-1", account_id: CODEX_ACCOUNT },
      last_refresh: "2026-08-01T00:00:00.000Z",
    }),
  );
  const grokSlot = (n) => ({
    [GROK_SLOT]: {
      key: jwt({ sub: GROK_SUBJECT, iat: T0 + n, exp: T0 + n + 3600, email: "grok@example.com" }),
      auth_mode: "oidc",
      create_time: "2026-06-01T00:00:00.000Z",
      user_id: GROK_SUBJECT,
      principal_id: GROK_SUBJECT,
      principal_type: "User",
      refresh_token: `grok-refresh-${n}`,
      expires_at: new Date((T0 + n + 3600) * 1000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    },
  });
  privateFile(path.join(grokRoot, "active-auth.json"), JSON.stringify({ version: 1, profileId: "personal" }));
  privateFile(path.join(grokRoot, "personal", "auth.json"), JSON.stringify(grokSlot(5)));
  privateFile(path.join(grokRoot, "personal", "auth.json.lock"), "");
  privateFile(path.join(grokHome, "auth.json"), JSON.stringify(grokSlot(2)));
  privateFile(
    path.join(piRoot, "auth.json"),
    JSON.stringify({ xai: { type: "oauth", access: jwt({ sub: "33333333-3333-4333-8333-333333333333", exp: T0 + 9999 }), refresh: "legacy-refresh", expires: (T0 + 9999) * 1000 - 300000 } }),
  );

  const report = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(report.failedStep, null, JSON.stringify(report));
  assert.deepEqual(Object.keys(report.providers), ["anthropic", "openai-codex", "xai"], "providers run in order");
  // Claude: Account 1 from ~/.claude.
  const claudeOne = await piStore.registry.accountOneProfile("anthropic");
  assert.equal(claudeOne.identityFingerprint, sha(CLAUDE_UUID));
  assert.equal(report.providers.anthropic.accountOne, claudeOne.id);
  // Codex: the vault is seeded from the live login, Account 1 created with
  // the account id fingerprint, marker personal.
  assert.deepEqual(report.providers["openai-codex"].beforePairing, { active: "personal" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexRoot, "active-auth.json"), "utf8")).profileId, "personal");
  assert.ok(fs.existsSync(path.join(codexRoot, "personal", "auth.json")), "the personal backup is seeded");
  const codexOne = await piStore.registry.accountOneProfile("openai-codex");
  assert.equal(codexOne.identityFingerprint, sha(CODEX_ACCOUNT));
  assert.equal(codexOne.accountEmail, "codex@example.com");
  const codexPi = JSON.parse(fs.readFileSync(H.piStore.piAccountProfilePaths(piRoot, codexOne.id).authFile, "utf8"))["openai-codex"];
  assert.equal(codexPi.access, codexAccess);
  assert.equal(codexPi.expires, (T0 + 240 * 3600) * 1000, "the row is created with the JWT expiry");
  assert.equal(codexPi.accountId, CODEX_ACCOUNT);
  // Grok: the vault's fresher personal login went back to ~/.grok, the vault
  // retired, Account 1 created from ~/.grok, the legacy xai row folded.
  assert.equal(report.providers.xai.beforePairing.personalRestored, true);
  assert.equal(fs.existsSync(path.join(grokRoot, "active-auth.json")), false);
  assert.equal(fs.existsSync(path.join(grokRoot, "personal")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(grokHome, "auth.json"), "utf8"))[GROK_SLOT].refresh_token, "grok-refresh-5");
  const grokOne = await piStore.registry.accountOneProfile("xai");
  assert.equal(grokOne.identityFingerprint, sha(GROK_SUBJECT));
  const xaiRows = (await piStore.registry.listProfiles("xai")).length;
  assert.equal(xaiRows, 2, "the legacy xai credential folded into its own row beside Account 1");
  assert.equal(fs.existsSync(path.join(piRoot, "auth.json")), false);
  assert.equal(report.providers.xai.watchedPairs, 1);
  assert.equal((await piStore.registry.snapshot()).defaults.anthropic, claudeOne.id);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], codexOne.id);
  pass("the pass runs every provider in order and creates the three Account 1 rows");

  // A second run makes no writes on any root.
  const before = [piRoot, claudeRoot, codexRoot, grokRoot, claudeHome, codexHome, grokHome].map(snapshotTree).join("\n===\n");
  const rerun = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(rerun.failedStep, null);
  for (const provider of ["anthropic", "openai-codex", "xai"]) {
    assert.deepEqual(rerun.providers[provider].paired, []);
    assert.deepEqual(rerun.providers[provider].clearedLinks, []);
  }
  assert.equal([piRoot, claudeRoot, codexRoot, grokRoot, claudeHome, codexHome, grokHome].map(snapshotTree).join("\n===\n"), before, "no writes on the second run");
  pass("the pass is idempotent over all three roots");

  // A failing Grok undo does not block Codex pairing, and the failure is
  // attributed to its step.
  const grokManagedHome = H.grokProfiles.grokCliManagedProfilePaths(grokRoot, GROK_MANAGED).homeDir;
  privateFile(path.join(grokRoot, "active-auth.json"), JSON.stringify({ version: 1, profileId: GROK_MANAGED }));
  privateFile(path.join(grokRoot, "personal", "auth.json"), "{{{");
  privateDir(grokManagedHome);
  privateFile(
    path.join(grokRoot, "account-profiles.json"),
    JSON.stringify({ version: 1, profiles: [{ id: GROK_MANAGED, label: "Managed", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }], defaultProfileId: "personal" }),
  );
  // An unlinked Codex row and a managed Codex vault slot of the same account
  // are paired by sha256(account_id).
  const CODEX_MANAGED_ACCOUNT = "acct-codex-2222";
  const codexRow = (await piStore.registry.registerProfile({ provider: "openai-codex", label: "Work", identityFingerprint: sha(CODEX_MANAGED_ACCOUNT) })).profile;
  const codexManaged = await codexStore.createProfile({ label: "Work" });
  privateFile(
    H.codexProfiles.codexCliManagedProfilePaths(codexRoot, codexManaged.profile.id).authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ exp: T0 + 3600, email: "work@example.com" }), access_token: jwt({ iat: T0, exp: T0 + 240 * 3600, "https://api.openai.com/auth": { chatgpt_account_id: CODEX_MANAGED_ACCOUNT } }), refresh_token: "work-refresh", account_id: CODEX_MANAGED_ACCOUNT },
      last_refresh: "2026-08-01T00:00:00.000Z",
    }),
  );
  const partial = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(partial.failedStep, null, "an unreadable Grok vault defers rather than fails");
  assert.ok(logs.some((line) => line.includes("kept for the next launch")));
  assert.deepEqual(partial.providers["openai-codex"].paired, [{ coraProfileId: codexRow.id, cliProfileId: codexManaged.profile.id, by: "fingerprint" }]);
  assert.equal((await piStore.registry.getProfile(codexRow.id)).cliProfileId, codexManaged.profile.id);
  assert.ok(fs.existsSync(path.join(grokRoot, "active-auth.json")), "the deferred Grok undo keeps its marker");
  const grokFailing = Object.create(services.xai);
  grokFailing.clearDanglingLinks = async () => {
    throw new Error("grok boom");
  };
  const failed = await H.migration.migrateUnifiedAccounts({ ...deps, services: { ...services, xai: grokFailing } });
  assert.equal(failed.failedStep, "xai:clear-dangling-links");
  assert.equal(failed.providers.xai.failedStep, "xai:clear-dangling-links");
  assert.equal(failed.providers["openai-codex"].failedStep, null);
  assert.equal(failed.providers.xai.watchedPairs, 1, "the provider's later steps still ran");
  pass("a failing Grok step is attributed and never blocks Codex");

  // The ready gate resolves after a failed step and installs the three
  // runtime hooks.
  H.migration.resetUnifiedAccountMigrationForTests();
  await H.migration.startUnifiedAccountMigration({ ...deps, services: { ...services, xai: grokFailing } });
  await H.migration.unifiedAccountsReady();
  assert.ok(logs.some((line) => line.includes('step "xai:clear-dangling-links" failed')));
  assert.equal(await H.migration.startUnifiedAccountMigration(deps), await H.migration.unifiedAccountsReady(), "the gate is process-wide");
  H.migration.resetUnifiedAccountMigrationForTests();
  pass("the ready gate resolves after a failed step");

  // The registry maps providers to runtimes both ways and reports terminal
  // statuses per provider.
  assert.equal(H.registry.cliRuntimeFor("anthropic"), "claude");
  assert.equal(H.registry.cliRuntimeFor("openai-codex"), "codex");
  assert.equal(H.registry.cliRuntimeFor("xai"), "grok");
  assert.equal(H.registry.providerForRuntime("grok"), "xai");
  assert.equal(H.registry.providerForRuntime("codex"), "openai-codex");
  assert.deepEqual(H.registry.UNIFIED_ACCOUNT_PROVIDERS, ["anthropic", "openai-codex", "xai"]);
  pass("the registry maps providers and runtimes both ways");

  mirror.stop();
  for (const service of Object.values(services)) service.stop();
  console.log(`\nPASS unified account migration (${passes} groups)`);
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
