#!/usr/bin/env node
"use strict";

// The Codex half of the startup pass: an unlinked Cora row pairs with the
// vault slot that holds the same ChatGPT account (sha256 of account_id on
// both sides), a marker that lags the store default is re-activated, and a
// row whose Codex half is live reads Account 1 from the live file while
// another row reads it from the vault.
//
//   node scripts/test-codex-account-migration.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-migration-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.CODEX_HOME;

const T0 = 1_900_000_000;
const LIFETIME = 240 * 3600;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const ACCOUNT_ONE = "acct-one";
const ACCOUNT_FP = "acct-fingerprint";
const ACCOUNT_EMAIL = "acct-email";
const ACCOUNT_MISMATCH_CORA = "acct-mismatch-cora";
const ACCOUNT_MISMATCH_CLI = "acct-mismatch-cli";
const CLI = {
  byFingerprint: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  byEmail: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  mismatch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  lagging: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
};
const authFile = (accountId, n, email) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ iat: T0 + n, exp: T0 + n + 3600, email }),
    access_token: jwt({ iat: T0 + n, exp: T0 + n + LIFETIME, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    refresh_token: `refresh-${accountId}-${n}`,
    account_id: accountId,
  },
  last_refresh: "2026-08-01T00:00:00.000Z",
});
const piCredential = (accountId, n) => ({
  type: "oauth",
  access: jwt({ iat: T0 + n, exp: T0 + n + LIFETIME, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  refresh: `pi-refresh-${accountId}-${n}`,
  expires: (T0 + n + LIFETIME) * 1000,
  accountId,
});

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as migration from ${JSON.stringify(orchestration("unified-account-migration.ts"))};`,
      `export * as codexAdapter from ${JSON.stringify(orchestration("account-adapters/codex-account-adapter.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as codexProfiles from ${JSON.stringify(orchestration("codex-cli-account-profiles.ts"))};`,
      `export * as execution from ${JSON.stringify(orchestration("codex-cli-profile-execution.ts"))};`,
      `export * as selector from ${JSON.stringify(orchestration("codex-cli-auth-selector.ts"))};`,
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
        name: "codex-migration-harness",
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

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const AuthStorage = await loadAuthStorage();
  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const codexRoot = path.join(HOME, ".codarastudio", "codex-cli");
  const codexHome = path.join(HOME, ".codex");
  privateDir(codexHome);
  const liveFile = path.join(codexHome, "auth.json");
  const vaultFile = (id) => H.codexProfiles.codexCliManagedProfilePaths(codexRoot, id).authFile;
  const marker = () => JSON.parse(fs.readFileSync(path.join(codexRoot, "active-auth.json"), "utf8")).profileId;
  const readPi = (coraId) => JSON.parse(fs.readFileSync(H.piStore.piAccountProfilePaths(piRoot, coraId).authFile, "utf8"))["openai-codex"];

  // The vault: four managed slots, the store default naming one of them
  // while the marker still names personal (a crash between the default
  // write and the activation), a live personal login.
  const cliMeta = (id, label) => ({ id, label, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" });
  privateFile(
    path.join(codexRoot, "account-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: [cliMeta(CLI.byFingerprint, "FP"), cliMeta(CLI.byEmail, "Email"), cliMeta(CLI.mismatch, "Mismatch"), cliMeta(CLI.lagging, "Lagging")],
      defaultProfileId: CLI.lagging,
    }),
  );
  privateFile(path.join(codexRoot, "active-auth.json"), JSON.stringify({ version: 1, profileId: "personal" }));
  privateFile(liveFile, JSON.stringify(authFile(ACCOUNT_ONE, 1, "one@example.com")));
  privateFile(vaultFile(CLI.byFingerprint), JSON.stringify(authFile(ACCOUNT_FP, 3, "fp@example.com")));
  privateFile(vaultFile(CLI.byEmail), JSON.stringify(authFile(ACCOUNT_EMAIL, 7, "Email@Example.com")));
  privateFile(vaultFile(CLI.mismatch), JSON.stringify(authFile(ACCOUNT_MISMATCH_CLI, 1, "shared@example.com")));
  privateFile(vaultFile(CLI.lagging), JSON.stringify(authFile("acct-lagging", 2, "lagging@example.com")));

  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const register = async (label, options = {}) => {
    const { profile } = await piStore.registry.registerProfile({
      provider: "openai-codex",
      label,
      ...(options.fingerprint ? { identityFingerprint: options.fingerprint } : {}),
      ...(options.email ? { accountEmail: options.email } : {}),
    });
    if (options.credential) {
      const { configDir, authFile: target } = H.piStore.piAccountProfilePaths(piRoot, profile.id);
      privateDir(configDir);
      await AuthStorage.create(target).modify("openai-codex", async () => options.credential);
      fs.chmodSync(target, 0o600);
    }
    return profile;
  };
  const rowByFingerprint = await register("FP row", { fingerprint: sha(ACCOUNT_FP), email: "unrelated@example.com", credential: piCredential(ACCOUNT_FP, 1) });
  const rowByEmail = await register("Email row", { email: "email@example.com", credential: piCredential(ACCOUNT_EMAIL, 9) });
  const rowMismatch = await register("Mismatch row", { fingerprint: sha(ACCOUNT_MISMATCH_CORA), email: "shared@example.com", credential: piCredential(ACCOUNT_MISMATCH_CORA, 1) });
  const rowLagging = await register("Lagging row", { fingerprint: sha("acct-lagging"), credential: piCredential("acct-lagging", 2) });
  await piStore.registry.setDefaultProfile("openai-codex", rowLagging.id);

  const leases = new H.execution.CodexCliProfileLeaseRegistry();
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, { personalHomeDir: codexHome, leases });
  const mirror = new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 30, retryDelayMs: 20 });
  const logs = [];
  const service = new H.accounts.UnifiedAccountService(
    H.codexAdapter.createCodexAccountAdapter({ store: codexStore, leases, loadAuthStorage, externalSessionCount: () => 0 }),
    { piStore, mirror, loadAuthStorage, invalidateCaches: async () => undefined, log: (message) => logs.push(message) },
  );
  const deps = { services: { "openai-codex": service }, providers: ["openai-codex"], piStore, codexStore, log: (message) => logs.push(message) };

  const report = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(report.failedStep, null, JSON.stringify(report));
  const entry = report.providers["openai-codex"];
  const byId = (id) => piStore.registry.getProfile(id);
  assert.equal((await byId(rowByFingerprint.id)).cliProfileId, CLI.byFingerprint);
  assert.equal((await byId(rowByEmail.id)).cliProfileId, CLI.byEmail);
  assert.equal((await byId(rowMismatch.id)).cliProfileId, undefined, "differing fingerprints never pair");
  assert.equal((await byId(rowLagging.id)).cliProfileId, CLI.lagging);
  assert.deepEqual(
    entry.paired.map((item) => `${item.coraProfileId}:${item.by}`).sort(),
    [`${rowByEmail.id}:email`, `${rowByFingerprint.id}:fingerprint`, `${rowLagging.id}:fingerprint`].sort(),
  );
  assert.ok(logs.some((line) => line.includes("by email")));
  // The first reconcile made the newer token win on both sides.
  assert.equal(readPi(rowByFingerprint.id).refresh, "refresh-acct-fingerprint-3", "the vault's fresher token flowed to Cora");
  assert.equal(JSON.parse(fs.readFileSync(vaultFile(CLI.byEmail), "utf8")).tokens.refresh_token, "pi-refresh-acct-email-9", "Cora's fresher token flowed to the vault");
  assert.equal(JSON.parse(fs.readFileSync(vaultFile(CLI.byEmail), "utf8")).tokens.id_token, authFile(ACCOUNT_EMAIL, 7, "Email@Example.com").tokens.id_token, "the id_token survived");
  pass("vault slots pair with rows by sha256(account_id), then by email, never across differing fingerprints");

  // Account 1 from the live file while the marker names personal; the row
  // carries the JWT expiry losslessly.
  const accountOne = await piStore.registry.accountOneProfile("openai-codex");
  assert.equal(accountOne.id, entry.accountOne);
  assert.equal(accountOne.identityFingerprint, sha(ACCOUNT_ONE));
  assert.equal(accountOne.accountEmail, "one@example.com");
  assert.equal(readPi(accountOne.id).expires, (T0 + 1 + LIFETIME) * 1000);
  pass("Account 1 is created from the live login");

  // The lagging marker: the store default names Lagging, the Cora default
  // its row, but the marker still named personal. Repair activates it: the
  // personal login is saved to its vault slot and Lagging's slot is live.
  assert.equal(marker(), CLI.lagging, "the marker follows the store default");
  assert.equal(JSON.parse(fs.readFileSync(liveFile, "utf8")).tokens.account_id, "acct-lagging");
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexRoot, "personal", "auth.json"), "utf8")).tokens.account_id, ACCOUNT_ONE);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], rowLagging.id);
  assert.equal(entry.watchedPairs, 4);
  const statuses = await service.terminalStatuses();
  assert.equal(statuses.get("personal").connected, true, "Account 1 reads its vault copy");
  assert.equal(statuses.get(CLI.lagging).connected, true, "the live account reads the live file");
  pass("a marker lagging the store default is re-activated");

  // Rerun: nothing changes.
  const before = fs.readFileSync(path.join(piRoot, "account-profiles.json"), "utf8");
  const liveBefore = fs.readFileSync(liveFile, "utf8");
  const rerun = await H.migration.migrateUnifiedAccounts(deps);
  assert.equal(rerun.failedStep, null);
  assert.deepEqual(rerun.providers["openai-codex"].paired, []);
  assert.equal(fs.readFileSync(path.join(piRoot, "account-profiles.json"), "utf8"), before);
  assert.equal(fs.readFileSync(liveFile, "utf8"), liveBefore);
  assert.equal(marker(), CLI.lagging);
  pass("the pass is idempotent");

  // The Cora default disappearing derives from the marker: with no Cora
  // default and the store on Lagging, the row linking it becomes default.
  await piStore.registry.setDefaultProfile("openai-codex", null);
  await H.migration.migrateUnifiedAccounts(deps);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], rowLagging.id);
  pass("a missing Cora default follows the Codex default");

  mirror.stop();
  service.stop();

  // First launch of a user whose Codex default is a managed profile the
  // old model let them choose: the pass must not flip their terminals to
  // the personal login just because the Cora default was never chosen.
  // Three layouts on fresh roots: no Cora rows at all, a Cora-only default
  // row of another account, and Account 1 holding a Cora default while the
  // managed profile links a row.
  const ACCOUNT_WORK = "acct-work";
  const CLI_WORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
  const world = async (name, rows) => {
    const root = path.join(TMP, name);
    const codaraHome = path.join(root, ".codarastudio");
    const wPiRoot = path.join(codaraHome, "pi-agent");
    const wCodexRoot = path.join(codaraHome, "codex-cli");
    const wCodexHome = path.join(root, ".codex");
    privateDir(wCodexHome);
    privateFile(
      path.join(wCodexRoot, "account-profiles.json"),
      JSON.stringify({ version: 1, profiles: [cliMeta(CLI_WORK, "Work")], defaultProfileId: CLI_WORK }),
    );
    privateFile(path.join(wCodexRoot, "active-auth.json"), JSON.stringify({ version: 1, profileId: CLI_WORK }));
    privateFile(path.join(wCodexHome, "auth.json"), JSON.stringify(authFile(ACCOUNT_WORK, 4, "work@example.com")));
    privateFile(H.codexProfiles.codexCliManagedProfilePaths(wCodexRoot, CLI_WORK).authFile, JSON.stringify(authFile(ACCOUNT_WORK, 4, "work@example.com")));
    privateFile(path.join(wCodexRoot, "personal", "auth.json"), JSON.stringify(authFile(ACCOUNT_ONE, 1, "one@example.com")));
    const wPiStore = new H.piStore.PiAccountAuthStore(wPiRoot);
    const registered = {};
    for (const row of rows) {
      const { profile } = await wPiStore.registry.registerProfile({
        provider: "openai-codex",
        label: row.label,
        ...(row.fingerprint ? { identityFingerprint: row.fingerprint } : {}),
        ...(row.cliProfileId ? { cliProfileId: row.cliProfileId } : {}),
      });
      const { configDir, authFile: target } = H.piStore.piAccountProfilePaths(wPiRoot, profile.id);
      privateDir(configDir);
      await AuthStorage.create(target).modify("openai-codex", async () => row.credential);
      fs.chmodSync(target, 0o600);
      registered[row.label] = profile;
    }
    if (rows.length > 0) {
      await wPiStore.registry.setDefaultProfile("openai-codex", rows[0].default === false ? null : registered[rows[0].label].id);
    }
    const wLeases = new H.execution.CodexCliProfileLeaseRegistry();
    const wCodexStore = new H.codexProfiles.CodexCliAccountProfileStore(wCodexRoot, { personalHomeDir: wCodexHome, leases: wLeases });
    const wMirror = new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 30, retryDelayMs: 20 });
    const wService = new H.accounts.UnifiedAccountService(
      H.codexAdapter.createCodexAccountAdapter({ store: wCodexStore, leases: wLeases, loadAuthStorage, externalSessionCount: () => 0 }),
      { piStore: wPiStore, mirror: wMirror, loadAuthStorage, invalidateCaches: async () => undefined, log: (message) => logs.push(message) },
    );
    const wReport = await H.migration.migrateUnifiedAccounts({
      services: { "openai-codex": wService },
      providers: ["openai-codex"],
      piStore: wPiStore,
      codexStore: wCodexStore,
      log: (message) => logs.push(message),
    });
    assert.equal(wReport.failedStep, null, JSON.stringify(wReport));
    const state = {
      storeDefault: (await wCodexStore.snapshot()).defaultProfileId,
      marker: JSON.parse(fs.readFileSync(path.join(wCodexRoot, "active-auth.json"), "utf8")).profileId,
      liveAccount: JSON.parse(fs.readFileSync(path.join(wCodexHome, "auth.json"), "utf8")).tokens.account_id,
      coraDefault: (await wPiStore.registry.snapshot()).defaults["openai-codex"],
      accountOne: await wPiStore.registry.accountOneProfile("openai-codex"),
      registered,
    };
    wMirror.stop();
    wService.stop();
    return state;
  };
  const untouched = (state) => {
    assert.equal(state.storeDefault, CLI_WORK, "the Codex store default is the user's managed profile");
    assert.equal(state.marker, CLI_WORK, "the marker still names the managed profile");
    assert.equal(state.liveAccount, ACCOUNT_WORK, "the live login is still the managed account");
  };

  const noRows = await world("no-rows", []);
  untouched(noRows);
  assert.ok(noRows.accountOne, "Account 1 is created from the personal vault copy");
  assert.equal(noRows.coraDefault, undefined, "no Cora row links the managed default, so no Cora default is invented");
  pass("a managed Codex default with no Cora rows keeps the user's terminals where they are");

  const coraOnly = await world("cora-only", [
    { label: "Elsewhere", fingerprint: sha("acct-elsewhere"), credential: piCredential("acct-elsewhere", 3) },
  ]);
  untouched(coraOnly);
  assert.equal(coraOnly.coraDefault, coraOnly.registered.Elsewhere.id, "a Cora-only default of another account stays the Cora default");
  pass("a managed Codex default beside a Cora-only default row leaves both defaults alone");

  const linked = await world("linked", [
    { label: "Account 1", fingerprint: sha(ACCOUNT_ONE), cliProfileId: "personal", credential: piCredential(ACCOUNT_ONE, 1) },
    { label: "Work", fingerprint: sha(ACCOUNT_WORK), credential: piCredential(ACCOUNT_WORK, 4) },
  ]);
  untouched(linked);
  assert.equal(linked.coraDefault, linked.registered.Work.id, "the row pairing with the managed default becomes the Cora default");
  pass("an Account 1 Cora default yields to the managed Codex default once its row is paired");

  console.log(`\nPASS codex account migration (${passes} groups)`);
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
