#!/usr/bin/env node
"use strict";

// The unified account service over the Codex adapter, against real temp
// roots: a real Pi account store and registry, the real auth-only vault and
// its marker, the real credential mirror and the REAL pinned Pi AuthStorage.
// The refresh grant is a stubbed fetch, the terminal session table and the
// external process count are stubs; identities come from JWT claims.
//
//   node scripts/test-codex-accounts.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-accounts-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.CODEX_HOME;

const CLI_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
];
const ACCOUNT_A = "acct-11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "acct-22222222-2222-4222-8222-222222222222";
const ACCOUNT_C = "acct-33333333-3333-4333-8333-333333333333";
const fingerprintOf = (accountId) => crypto.createHash("sha256").update(accountId).digest("hex");
const T0 = 1_900_000_000;
const LIFETIME = 240 * 3600;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const accessFor = (accountId, n) =>
  jwt({ iat: T0 + n, exp: T0 + n + LIFETIME, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
const idTokenFor = (accountId, n) =>
  jwt({ iat: T0 + n, exp: T0 + n + 3600, email: `${accountId.slice(5, 13)}@example.com` });

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as codexAdapter from ${JSON.stringify(orchestration("account-adapters/codex-account-adapter.ts"))};`,
      `export * as codexCodec from ${JSON.stringify(orchestration("account-adapters/codex-credential-codec.ts"))};`,
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
        name: "codex-accounts-harness",
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

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("condition not met in time");
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
  const vaultFile = (cliId) =>
    cliId === "personal"
      ? H.selector.codexCliPersonalAuthFile(codexRoot)
      : H.codexProfiles.codexCliManagedProfilePaths(codexRoot, cliId).authFile;
  const marker = () =>
    fs.existsSync(path.join(codexRoot, "active-auth.json"))
      ? JSON.parse(fs.readFileSync(path.join(codexRoot, "active-auth.json"), "utf8")).profileId
      : null;
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.CodexCliProfileLeaseRegistry();
  let cliIndex = 0;
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: codexHome,
    personalAuthFile: H.selector.codexCliPersonalAuthFile(codexRoot),
    leases,
    idFactory: () => CLI_IDS[cliIndex++],
  });
  const grants = [];
  let grantResponse = null;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    grants.push({ url, body });
    if (typeof grantResponse === "function") return grantResponse(body);
    return { ok: false, status: 429, text: async () => "slow down" };
  };
  let externalSessions = 0;
  const adapter = H.codexAdapter.createCodexAccountAdapter({
    store: codexStore,
    leases,
    loadAuthStorage,
    fetchImpl,
    externalSessionCount: () => externalSessions,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  });
  const mirror = new H.mirror.CredentialMirror({
    loadAuthStorage,
    pollWhenWatchBlind: null,
    debounceMs: 30,
    retryDelayMs: 20,
  });
  let broadcasts = 0;
  const liveOwners = new Set();
  const disposed = [];
  const shutdowns = [];
  const logs = [];
  const service = new H.accounts.UnifiedAccountService(adapter, {
    piStore,
    mirror,
    loadAuthStorage,
    invalidateCaches: async () => undefined,
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
        return { closedSessionCount: count };
      },
    },
    sessionShutdown: async () => {
      let count = externalSessions;
      externalSessions = 0;
      for (const owner of [...liveOwners]) {
        liveOwners.delete(owner);
        count += 1;
      }
      leases.sweep(liveOwners);
      shutdowns.push(count);
      return { closedSessionCount: count };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(service.provider, "openai-codex");

  const authFile = (accountId, n, extra = {}) => ({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idTokenFor(accountId, n),
      access_token: accessFor(accountId, n),
      refresh_token: `refresh-${accountId.slice(5, 13)}-${n}`,
      account_id: accountId,
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
    ...extra,
  });
  const writeFile = (file, value) => privateFile(file, JSON.stringify(value, null, 2));
  const readFile = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  const piCredential = (accountId, n) => ({
    type: "oauth",
    access: accessFor(accountId, n),
    refresh: `refresh-${accountId.slice(5, 13)}-${n}`,
    expires: (T0 + n + LIFETIME) * 1000 - 12345,
    accountId,
  });
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) =>
    fs.existsSync(piAuthFile(coraId))
      ? JSON.parse(fs.readFileSync(piAuthFile(coraId), "utf8"))["openai-codex"] ?? null
      : null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile: target } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(target).modify("openai-codex", async () => credential);
    fs.chmodSync(target, 0o600);
  };
  const connectCora = async (label, accountId, n) => {
    const target = await piStore.prepareCredentialTarget({
      provider: "openai-codex",
      label,
      identityFingerprint: fingerprintOf(accountId),
    });
    await writePi(target.profile.id, piCredential(accountId, n));
    return target.profile;
  };

  // Account 1 from the live file while the marker names personal.
  assert.equal(await service.ensureAccountOne(), null);
  writeFile(liveFile, authFile(ACCOUNT_A, 2));
  await H.selector.ensureCodexCliAuthVault(codexStore);
  assert.equal(marker(), "personal");
  const accountOne = await service.ensureAccountOne();
  assert.equal(accountOne.label, "Account 1");
  assert.equal(accountOne.cliProfileId, "personal");
  assert.equal(accountOne.identityFingerprint, fingerprintOf(ACCOUNT_A));
  assert.equal(accountOne.accountEmail, "11111111@example.com");
  assert.deepEqual(readPi(accountOne.id), {
    type: "oauth",
    access: accessFor(ACCOUNT_A, 2),
    refresh: "refresh-11111111-2",
    expires: (T0 + 2 + LIFETIME) * 1000,
    accountId: ACCOUNT_A,
    idToken: idTokenFor(ACCOUNT_A, 2),
  });
  assert.equal(mode(piAuthFile(accountOne.id)), 0o600);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], accountOne.id);
  pass("Account 1 is created from the live ~/.codex login with the JWT expiry");

  // Live rotation (Codex refreshed in place) lands in Pi and the vault copy.
  writeFile(liveFile, authFile(ACCOUNT_A, 10));
  const rotated = await service.reconcileCliProfile("personal");
  assert.equal(rotated.wrote, "pi");
  assert.equal(readPi(accountOne.id).access, accessFor(ACCOUNT_A, 10));
  assert.equal(readPi(accountOne.id).expires, (T0 + 10 + LIFETIME) * 1000);
  // Pi rotation lands in the live file and the vault, with id_token kept.
  await writePi(accountOne.id, piCredential(ACCOUNT_A, 20));
  const back = await service.reconcileProfile(accountOne.id);
  assert.equal(back.wrote, "cli");
  const liveAfter = readFile(liveFile);
  assert.equal(liveAfter.tokens.access_token, accessFor(ACCOUNT_A, 20));
  assert.equal(liveAfter.tokens.refresh_token, "refresh-11111111-20");
  assert.equal(liveAfter.tokens.id_token, idTokenFor(ACCOUNT_A, 10), "id_token survives a Pi rotation");
  assert.equal(liveAfter.tokens.account_id, ACCOUNT_A);
  assert.equal(liveAfter.last_refresh, "2026-08-30T12:00:00.000Z");
  assert.equal(mode(liveFile), 0o600);
  assert.deepEqual(readFile(vaultFile("personal")), liveAfter, "the vault trails the live file");
  assert.equal(mode(vaultFile("personal")), 0o600);
  pass("rotations flow live -> Pi and Pi -> live+vault with id_token preserved");

  // A Cora sign-in of another account: the Codex half needs an id_token,
  // which only a refresh grant returns. A refused grant leaves the row
  // Cora-only; a successful one writes Pi first, then the vault slot.
  const work = await connectCora("Work", ACCOUNT_B, 5);
  const canonical = H.codexCodec.canonicalFromCodexPi(piCredential(ACCOUNT_B, 5));
  await assert.rejects(() => service.ensureCliHalf(work.id, canonical), /refused \(429\)/);
  assert.equal((await piStore.registry.getProfile(work.id)).cliProfileId, undefined);
  assert.equal((await codexStore.snapshot()).profiles.length, 0, "no half-built vault slot");
  assert.equal(readPi(work.id).refresh, "refresh-22222222-5", "a failed grant leaves Pi untouched");
  grantResponse = (body) => {
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(body.scope, "openid profile email");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: accessFor(ACCOUNT_B, 6),
          refresh_token: "refresh-22222222-6",
          id_token: idTokenFor(ACCOUNT_B, 6),
          expires_in: LIFETIME,
        }),
    };
  };
  const workCli = await service.ensureCliHalf(work.id, canonical);
  assert.equal(workCli, CLI_IDS[0]);
  assert.equal(grants.at(-1).body.refresh_token, "refresh-22222222-5", "the grant used Pi's refresh token");
  const workPi = readPi(work.id);
  assert.equal(workPi.access, accessFor(ACCOUNT_B, 6));
  assert.equal(workPi.refresh, "refresh-22222222-6", "the rotated refresh token reached Pi");
  assert.equal(workPi.idToken, idTokenFor(ACCOUNT_B, 6));
  assert.equal(workPi.accountId, ACCOUNT_B);
  const workVault = readFile(vaultFile(workCli));
  assert.equal(workVault.tokens.id_token, idTokenFor(ACCOUNT_B, 6));
  assert.equal(workVault.tokens.access_token, accessFor(ACCOUNT_B, 6));
  assert.equal(workVault.tokens.account_id, ACCOUNT_B);
  assert.equal(workVault.auth_mode, "chatgpt");
  assert.equal(mode(vaultFile(workCli)), 0o600);
  assert.equal(marker(), "personal", "sharing does not move the live slot");
  assert.equal(readFile(liveFile).tokens.account_id, ACCOUNT_A);
  assert.equal((await piStore.registry.getProfile(work.id)).cliProfileId, workCli);
  pass("ensureCliHalf grows a Cora-only account through one refresh grant and writes the vault slot");

  // A concurrent Pi refresh wins over the grant.
  const racer = await connectCora("Racer", ACCOUNT_C, 7);
  grantResponse = async () => {
    await writePi(racer.id, piCredential(ACCOUNT_C, 9));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: accessFor(ACCOUNT_C, 8),
          refresh_token: "refresh-33333333-8",
          id_token: idTokenFor(ACCOUNT_C, 8),
          expires_in: LIFETIME,
        }),
    };
  };
  await assert.rejects(
    () => service.ensureCliHalf(racer.id, H.codexCodec.canonicalFromCodexPi(piCredential(ACCOUNT_C, 7))),
    /refreshed this account/,
  );
  assert.equal(readPi(racer.id).refresh, "refresh-33333333-9", "the concurrent Pi refresh is kept");
  assert.equal((await piStore.registry.getProfile(racer.id)).cliProfileId, undefined);
  await piStore.deleteProfile(racer.id);
  pass("a Pi refresh that lands during the grant wins and the grant's tokens are dropped");

  // Switch: same id is a no-op for the side effects; a different id refuses
  // with a count while sessions run, then closes only after consent and
  // moves the live file and the marker.
  broadcasts = 0;
  await service.useAccount(accountOne.id);
  assert.deepEqual(shutdowns, []);
  assert.equal(marker(), "personal");
  leases.acquire("personal", "terminal:codex-pane");
  liveOwners.add("terminal:codex-pane");
  externalSessions = 2;
  await assert.rejects(
    () => service.useAccount(work.id),
    (error) => error.name === "UnifiedAccountSessionsError" && error.sessionCount === 3 && /switch/.test(error.message),
  );
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], accountOne.id, "a refused switch moves nothing");
  assert.equal(marker(), "personal");
  const switched = await service.useAccount(work.id, { closeSessions: true });
  assert.equal(switched.closedSessionCount, 3);
  assert.deepEqual(shutdowns, [3]);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], work.id);
  assert.equal((await codexStore.snapshot()).defaultProfileId, workCli);
  assert.equal(marker(), workCli);
  assert.equal(readFile(liveFile).tokens.account_id, ACCOUNT_B, "the live file is the switched account");
  assert.equal(readFile(vaultFile("personal")).tokens.account_id, ACCOUNT_A, "Account 1 is saved to its vault slot");
  assert.equal(await adapter.activeCliProfileId(), workCli);
  await service.useAccount(work.id);
  assert.deepEqual(shutdowns, [3], "switching to the active account closes nothing");
  pass("a switch refuses with a session count, then closes sessions and moves the live slot");

  // Live-while-active: the switched account's slot is now the live file. A
  // rotation there lands in Pi; a Pi rotation lands in the live file and the
  // vault; Account 1's vault copy is what its pair reads now.
  writeFile(liveFile, authFile(ACCOUNT_B, 30));
  assert.equal((await service.reconcileCliProfile(workCli)).wrote, "pi");
  assert.equal(readPi(work.id).access, accessFor(ACCOUNT_B, 30));
  assert.equal(readFile(vaultFile(workCli)).tokens.access_token, accessFor(ACCOUNT_B, 6), "the vault only trails on a Codara write");
  await writePi(work.id, piCredential(ACCOUNT_B, 40));
  assert.equal((await service.reconcileProfile(work.id)).wrote, "cli");
  assert.equal(readFile(liveFile).tokens.access_token, accessFor(ACCOUNT_B, 40));
  assert.equal(readFile(vaultFile(workCli)).tokens.access_token, accessFor(ACCOUNT_B, 40));
  assert.equal(readFile(liveFile).tokens.id_token, idTokenFor(ACCOUNT_B, 30));
  const one = await service.reconcileProfile(accountOne.id);
  assert.equal(one.verdict, "equal", "Account 1 reads its vault copy while another account is live");
  const statuses = await service.terminalStatuses();
  assert.equal(statuses.get("personal").connected, true);
  assert.equal(statuses.get(workCli).connected, true);
  assert.equal(statuses.get(workCli).canRefresh, true);
  pass("the live file answers for the active account and the vault for the others");

  // An external `codex logout` while Work is live signs Work out of Cora
  // and empties its vault copy; it does not touch Account 1.
  mirror.watch(service.pairFromProfile(await piStore.registry.getProfile(work.id)));
  await mirror.reconcileNow(work.id);
  fs.rmSync(liveFile);
  const signedOut = await service.reconcileProfile(work.id);
  assert.equal(signedOut.verdict, "pi-only");
  assert.equal(signedOut.wrote, null, "a managed slot going empty is never propagated as a delete");
  assert.equal((await service.terminalStatuses()).get(workCli).connected, false, "an external logout shows as signed out");
  assert.equal(readPi(work.id).access, accessFor(ACCOUNT_B, 40), "Cora keeps the login");
  writeFile(liveFile, authFile(ACCOUNT_B, 41));
  assert.equal((await service.reconcileProfile(work.id)).wrote, "pi");
  pass("an external codex logout is reported without deleting the Cora half");

  // A rotation arriving between the debounce and the write lands in the
  // right file: the switch and the mirror serialize on the selection lock.
  {
    const pairs = new H.mirror.CredentialMirror({ loadAuthStorage, pollWhenWatchBlind: null, debounceMs: 40, retryDelayMs: 20 });
    pairs.watch(service.pairFromProfile(await piStore.registry.getProfile(work.id)));
    pairs.watch(service.pairFromProfile(await piStore.registry.getProfile(accountOne.id)));
    await pairs.reconcileAll();
    await sleep(150);
    // Cora rotates Work while Work is live, and the user switches to
    // Account 1 in the same instant.
    await writePi(work.id, piCredential(ACCOUNT_B, 50));
    await sleep(10);
    await H.selector.activateCodexCliAccount(codexStore, "personal");
    await waitFor(async () => readFile(vaultFile(workCli))?.tokens.access_token === accessFor(ACCOUNT_B, 50));
    await sleep(200);
    assert.equal(readFile(liveFile).tokens.account_id, ACCOUNT_A, "the live file never received Work's token after the switch");
    assert.equal(readFile(vaultFile(workCli)).tokens.access_token, accessFor(ACCOUNT_B, 50), "Work's rotation landed in its vault slot");
    await H.selector.activateCodexCliAccount(codexStore, workCli);
    pairs.stop();
    pass("a rotation arriving mid-switch lands in the account's own slot");
  }

  // Delete: hand-off to Account 1 even when Account 1 is signed out
  // everywhere; the marker follows and the vault slot goes.
  fs.rmSync(vaultFile("personal"));
  await AuthStorage.create(piAuthFile(accountOne.id)).delete("openai-codex");
  leases.acquire(workCli, "terminal:codex-work");
  liveOwners.add("terminal:codex-work");
  await assert.rejects(
    () => service.deleteAccount(work.id),
    (error) => error.name === "UnifiedAccountSessionsError",
  );
  const deleted = await service.deleteAccount(work.id, { closeSessions: true });
  assert.equal(deleted.deleted, true);
  assert.equal(marker(), "personal", "the marker follows the hand-off");
  assert.equal(fs.existsSync(liveFile), false, "a signed-out Account 1 leaves no live file");
  assert.equal(fs.existsSync(vaultFile(workCli)), false);
  assert.equal(fs.existsSync(path.dirname(vaultFile(workCli))), false);
  assert.equal(await piStore.registry.getProfile(work.id), null);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], undefined);
  assert.equal((await codexStore.snapshot()).defaultProfileId, "personal");
  pass("delete hands off to a signed-out Account 1 and removes the vault slot");

  // Activation failure rolls back both defaults and the marker.
  writeFile(liveFile, authFile(ACCOUNT_A, 60));
  await service.reconcileProfile(accountOne.id).catch(() => null);
  await service.ensureAccountOne();
  await writePi(accountOne.id, piCredential(ACCOUNT_A, 60));
  await service.useAccount(accountOne.id);
  const other = await connectCora("Other", ACCOUNT_C, 70);
  grantResponse = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: accessFor(ACCOUNT_C, 71),
        refresh_token: "refresh-33333333-71",
        id_token: idTokenFor(ACCOUNT_C, 71),
        expires_in: LIFETIME,
      }),
  });
  const otherCli = await service.ensureCliHalf(other.id, H.codexCodec.canonicalFromCodexPi(piCredential(ACCOUNT_C, 70)));
  // A vault slot that vanished is rebuilt from Cora by the reconcile a
  // switch runs first, so the switch still succeeds; a live file that is
  // not a regular file makes the activation itself fail after both
  // defaults moved, which is the rollback path.
  fs.rmSync(vaultFile(otherCli));
  await service.useAccount(other.id);
  assert.equal(marker(), otherCli);
  assert.equal(readFile(vaultFile(otherCli)).tokens.access_token, accessFor(ACCOUNT_C, 71));
  await service.useAccount(accountOne.id);
  assert.equal(marker(), "personal");
  const liveBytes = fs.readFileSync(liveFile);
  fs.rmSync(liveFile);
  fs.symlinkSync(path.join(codexHome, "elsewhere.json"), liveFile);
  await assert.rejects(() => service.useAccount(other.id), /not a regular file/);
  assert.equal((await piStore.registry.snapshot()).defaults["openai-codex"], accountOne.id, "the Cora default is rolled back");
  assert.equal((await codexStore.snapshot()).defaultProfileId, "personal", "the Codex default is rolled back");
  assert.equal(marker(), "personal");
  fs.rmSync(liveFile);
  privateFile(liveFile, liveBytes);
  assert.equal(readFile(liveFile).tokens.account_id, ACCOUNT_A);
  pass("a failed activation rolls back both defaults and leaves the marker");

  // Every produced file is owner-only.
  const offending = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else if (/auth\.json$|account-profiles\.json$/.test(entry.name) && (mode(file) & 0o077) !== 0) {
        offending.push(file);
      }
    }
  };
  visit(path.join(HOME, ".codarastudio"));
  visit(codexHome);
  assert.deepEqual(offending, []);
  const dumped = JSON.stringify(await service.listAccounts());
  for (const forbidden of [codexRoot, piRoot, "refresh-", "eyJ"]) {
    assert.equal(dumped.includes(forbidden), false, `${forbidden} must not be listed`);
  }
  pass("every produced file is owner-only and the list is token-blind");

  mirror.stop();
  service.stop();
  console.log(`\nPASS unified Codex account service (${passes} groups)`);
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
