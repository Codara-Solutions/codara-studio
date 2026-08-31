#!/usr/bin/env node
"use strict";

// The unified account service over the Grok adapter, against real temp
// roots: a real Pi account store and registry, a real managed Grok profile
// store (with the shared-state links), the real credential mirror and the
// REAL pinned Pi AuthStorage. Only the terminal session table is stubbed;
// identities come from the JWT claims, so nothing touches the network.
//
//   node scripts/test-grok-accounts.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-grok-accounts-"));
const HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.GROK_HOME;

const CLI_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
];
const SUBJECT_A = "11111111-1111-4111-8111-111111111111";
const SUBJECT_B = "22222222-2222-4222-8222-222222222222";
const SUBJECT_C = "33333333-3333-4333-8333-333333333333";
const fingerprintOf = (subject) => crypto.createHash("sha256").update(subject).digest("hex");
const SKEW = 5 * 60 * 1000;
const T0 = 1_900_000_000;
const SLOT = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const keyFor = (subject, n, email) =>
  jwt({ sub: subject, iat: T0 + n, exp: T0 + n + 3600, email: email ?? `${subject.slice(0, 8)}@example.com` });

const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as accounts from ${JSON.stringify(orchestration("unified-accounts.ts"))};`,
      `export * as grokAdapter from ${JSON.stringify(orchestration("account-adapters/grok-account-adapter.ts"))};`,
      `export * as grokCodec from ${JSON.stringify(orchestration("account-adapters/grok-credential-codec.ts"))};`,
      `export * as mirror from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as piStore from ${JSON.stringify(orchestration("pi-account-auth-store.ts"))};`,
      `export * as grokProfiles from ${JSON.stringify(orchestration("grok-cli-account-profiles.ts"))};`,
      `export * as execution from ${JSON.stringify(orchestration("grok-cli-profile-execution.ts"))};`,
      `export * as runtime from ${JSON.stringify(orchestration("native-grok-profile-runtime.ts"))};`,
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
        name: "grok-accounts-harness",
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
  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const grokRoot = path.join(HOME, ".codarastudio", "grok-cli");
  const personalHome = path.join(HOME, ".grok");
  privateDir(personalHome);
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.GrokCliProfileLeaseRegistry();
  let cliIndex = 0;
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: personalHome,
    leases,
    idFactory: () => CLI_IDS[cliIndex++],
  });
  const adapter = H.grokAdapter.createGrokAccountAdapter({ store: grokStore, leases });
  const mirror = new H.mirror.CredentialMirror({
    loadAuthStorage,
    pollWhenWatchBlind: null,
    debounceMs: 30,
    retryDelayMs: 20,
  });
  // These pairs are WATCHED: writing a file the mirror watches schedules a
  // debounced reconcile that can perform the write before the explicit call
  // below reaches it, leaving that call with an already-synced pair. Both
  // orders are the mirror doing the same correct thing, so accept either and
  // let the state assertions that follow pin the credential that had to move.
  const syncedInto = (result, side) =>
    result.wrote === side || result.verdict === "equal" || result.verdict === "none";
  let broadcasts = 0;
  let invalidations = 0;
  const liveOwners = new Set();
  const disposed = [];
  const logs = [];
  const service = new H.accounts.UnifiedAccountService(adapter, {
    piStore,
    mirror,
    loadAuthStorage,
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
        void service.reconcileCliProfile(profileId).catch(() => null);
        return { closedSessionCount: count };
      },
    },
    log: (message) => logs.push(message),
  });
  assert.equal(service.provider, "xai");
  assert.equal(adapter.labels.cliLabel, "Grok");

  const slotFile = (subject, n, extra = {}) => ({
    [SLOT]: {
      key: keyFor(subject, n),
      auth_mode: "oidc",
      create_time: "2026-06-01T00:00:00.000Z",
      user_id: subject,
      email: `${subject.slice(0, 8)}@example.com`,
      first_name: "First",
      last_name: "Last",
      profile_image_asset_id: "",
      principal_type: "User",
      principal_id: subject,
      team_id: "",
      coding_data_retention_opt_out: false,
      refresh_token: `refresh-${subject.slice(0, 8)}-${n}`,
      expires_at: new Date((T0 + n + 3600) * 1000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      ...extra,
    },
  });
  const writeSlot = (homeDir, file) => {
    privateDir(homeDir);
    const target = path.join(homeDir, "auth.json");
    fs.writeFileSync(target, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  };
  const readSlot = (homeDir) => {
    const target = path.join(homeDir, "auth.json");
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8"))[SLOT] : null;
  };
  const piCredential = (subject, n) => ({
    type: "oauth",
    access: keyFor(subject, n),
    refresh: `refresh-${subject.slice(0, 8)}-${n}`,
    expires: (T0 + n + 3600) * 1000 - SKEW,
  });
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) =>
    fs.existsSync(piAuthFile(coraId))
      ? JSON.parse(fs.readFileSync(piAuthFile(coraId), "utf8")).xai ?? null
      : null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(authFile).modify("xai", async () => credential);
    fs.chmodSync(authFile, 0o600);
  };
  const managedHome = (cliId) => H.grokProfiles.grokCliManagedProfilePaths(grokRoot, cliId).homeDir;
  const connectCora = async (label, subject, n) => {
    const target = await piStore.prepareCredentialTarget({
      provider: "xai",
      label,
      identityFingerprint: fingerprintOf(subject),
      accountEmail: `${subject.slice(0, 8)}@example.com`,
    });
    await writePi(target.profile.id, piCredential(subject, n));
    return target.profile;
  };

  // No login in ~/.grok: no Account 1 row.
  assert.equal(await service.ensureAccountOne(), null);
  assert.deepEqual(await piStore.registry.listProfiles(), []);
  pass("ensureAccountOne creates nothing while ~/.grok holds no login");

  // A login lands in ~/.grok (as grok login writes it): Account 1 is created
  // losslessly, with the skewed expiry Pi expects.
  writeSlot(personalHome, slotFile(SUBJECT_A, 2));
  const accountOne = await service.ensureAccountOne();
  assert.equal(accountOne.label, "Account 1");
  assert.equal(accountOne.cliProfileId, "personal");
  assert.equal(accountOne.identityFingerprint, fingerprintOf(SUBJECT_A));
  assert.equal(accountOne.accountEmail, "11111111@example.com");
  assert.deepEqual(readPi(accountOne.id), {
    type: "oauth",
    access: keyFor(SUBJECT_A, 2),
    refresh: "refresh-11111111-2",
    expires: (T0 + 2 + 3600) * 1000 - SKEW,
  });
  assert.equal(mode(piAuthFile(accountOne.id)), 0o600);
  assert.equal((await piStore.registry.snapshot()).defaults.xai, accountOne.id);
  assert.equal((await service.ensureAccountOne()).id, accountOne.id, "rerun is idempotent");
  assert.equal(mirror.pairFor(accountOne.id).cliProfileId, "personal");
  assert.equal(mirror.pairFor(accountOne.id).provider, "xai");
  pass("ensureAccountOne creates the Account 1 row from ~/.grok and mirrors its token to Cora");

  // A Cora sign-in gets its Grok half: a managed GROK_HOME with the full
  // verified slot and the shared-state links to ~/.grok.
  const work = await connectCora("Work", SUBJECT_B, 5);
  const canonical = H.grokCodec.canonicalFromGrokPi(piCredential(SUBJECT_B, 5));
  const workCli = await service.ensureCliHalf(work.id, canonical, { fingerprint: fingerprintOf(SUBJECT_B), email: "22222222@example.com" });
  assert.equal(workCli, CLI_IDS[0]);
  const workHome = managedHome(workCli);
  assert.equal(mode(workHome), 0o700);
  assert.equal(mode(path.join(workHome, "auth.json")), 0o600);
  const workSlot = readSlot(workHome);
  assert.equal(workSlot.key, keyFor(SUBJECT_B, 5));
  assert.equal(workSlot.refresh_token, "refresh-22222222-5");
  assert.equal(workSlot.user_id, SUBJECT_B);
  assert.equal(workSlot.principal_id, SUBJECT_B);
  assert.equal(workSlot.auth_mode, "oidc");
  assert.equal(workSlot.email, "22222222@example.com");
  assert.equal(workSlot.oidc_client_id, "b1a00492-073a-47ea-816f-4c329264a828");
  assert.equal(workSlot.expires_at, new Date((T0 + 5 + 3600) * 1000).toISOString());
  if (process.platform !== "win32") {
    assert.ok(fs.lstatSync(path.join(workHome, "sessions")).isSymbolicLink(), "sessions are shared with ~/.grok");
    assert.equal(fs.realpathSync(path.join(workHome, "sessions")), fs.realpathSync(path.join(personalHome, "sessions")));
  }
  assert.equal((await piStore.registry.getProfile(work.id)).cliProfileId, workCli);
  assert.equal(mirror.pairFor(work.id).location.homeDir, workHome);
  assert.equal(await service.ensureCliHalf(work.id, canonical), workCli, "a linked row keeps its half");
  pass("ensureCliHalf writes a managed GROK_HOME with the verified slot and the shared-state links");

  // Use this account: both defaults move together, nothing is disposed.
  broadcasts = 0;
  invalidations = 0;
  await service.useAccount(work.id);
  assert.equal((await piStore.registry.snapshot()).defaults.xai, work.id);
  assert.equal((await grokStore.snapshot()).defaultProfileId, workCli);
  assert.equal(disposed.length, 0);
  assert.ok(broadcasts >= 1 && invalidations >= 1);
  const resolved = await H.execution.resolveGrokCliExecutionProfile(grokStore, { useDefault: true, baseEnv: { PATH: "/bin", XAI_API_KEY: "leak" } });
  assert.equal(resolved.env.GROK_HOME, workHome, "a new Grok terminal starts in the managed home");
  assert.equal(resolved.env.XAI_API_KEY, undefined);
  await service.useAccount(accountOne.id);
  assert.equal((await grokStore.snapshot()).defaultProfileId, "personal");
  const personalResolved = await H.execution.resolveGrokCliExecutionProfile(grokStore, { useDefault: true, baseEnv: { PATH: "/bin" } });
  assert.equal(personalResolved.env.GROK_HOME, personalHome);
  const empty = (await piStore.registry.registerProfile({ provider: "xai", label: "Empty" })).profile;
  await assert.rejects(
    () => service.useAccount(empty.id),
    (error) => error.name === "UnifiedAccountNotConnectedError" && /Grok/.test(error.message),
  );
  await piStore.registry.deleteProfile(empty.id);
  pass("useAccount flips both defaults in one step and kills nothing");

  // The mirror: a rotation in the managed home (Grok refreshed) reaches
  // Cora; a Pi rotation reaches the slot with its metadata intact.
  writeSlot(workHome, slotFile(SUBJECT_B, 30, { first_name: "Rotated" }));
  const rotated = await service.reconcileCliProfile(workCli);
  assert.ok(syncedInto(rotated, "pi"), JSON.stringify(rotated));
  assert.equal(readPi(work.id).access, keyFor(SUBJECT_B, 30));
  assert.equal(readPi(work.id).expires, (T0 + 30 + 3600) * 1000 - SKEW);
  await writePi(work.id, piCredential(SUBJECT_B, 40));
  const back = await service.reconcileProfile(work.id);
  assert.ok(syncedInto(back, "cli"), JSON.stringify(back));
  const rotatedSlot = readSlot(workHome);
  assert.equal(rotatedSlot.key, keyFor(SUBJECT_B, 40));
  assert.equal(rotatedSlot.refresh_token, "refresh-22222222-40");
  assert.equal(rotatedSlot.first_name, "Rotated", "slot metadata survives a Cora rotation");
  assert.equal(rotatedSlot.expires_at, new Date((T0 + 40 + 3600) * 1000).toISOString());
  assert.equal(mode(path.join(workHome, "auth.json")), 0o600);
  assert.equal((await service.reconcileProfile(work.id)).verdict, "equal");
  pass("rotations flow both ways with the slot's metadata preserved");

  // Share from Grok to Cora: a terminal-only managed profile.
  const terminalOnly = await grokStore.createProfile({ label: "Terminal only" });
  writeSlot(managedHome(terminalOnly.profile.id), slotFile(SUBJECT_C, 8));
  await grokStore.setDefaultProfile(terminalOnly.profile.id);
  const listedBefore = await service.listAccounts();
  assert.deepEqual(listedBefore.terminalOnly.map((entry) => entry.cliProfileId), [terminalOnly.profile.id]);
  assert.equal(listedBefore.terminalOnly[0].terminal.connected, true);
  assert.equal(listedBefore.terminalOnly[0].terminal.canRefresh, true);
  const sharedCli = await service.shareLogin({ cliProfileId: terminalOnly.profile.id });
  const sharedRow = await piStore.registry.getProfile(sharedCli.coraProfileId);
  assert.equal(sharedRow.label, "Terminal only");
  assert.equal(sharedRow.identityFingerprint, fingerprintOf(SUBJECT_C));
  assert.equal(sharedRow.accountEmail, "33333333@example.com");
  assert.equal(readPi(sharedRow.id).access, keyFor(SUBJECT_C, 8));
  assert.equal((await piStore.registry.snapshot()).defaults.xai, sharedRow.id, "sharing the CLI default makes the pair active");
  assert.deepEqual((await service.listAccounts()).terminalOnly, []);
  pass("shareLogin gives a terminal-only Grok profile its Cora half");

  // The list carries both halves, token-blind.
  const listed = await service.listAccounts();
  const byId = new Map(listed.accounts.map((entry) => [entry.coraProfileId, entry]));
  assert.equal(byId.get(accountOne.id).isAccount1, true);
  assert.equal(byId.get(accountOne.id).terminal.connected, true);
  assert.equal(byId.get(work.id).terminal.expired, false);
  assert.equal(byId.get(sharedRow.id).isDefault, true);
  const listedJson = JSON.stringify(listed);
  for (const forbidden of [grokRoot, piRoot, "refresh-", "eyJ"]) {
    assert.equal(listedJson.includes(forbidden), false, `${forbidden} must not be listed`);
  }
  pass("listAccounts reports both halves without paths or tokens");

  // Delete: the active account is refused while leased, then hands both
  // defaults to Account 1 and removes the managed home.
  const releaseLease = leases.acquire(terminalOnly.profile.id, "terminal:pane-1");
  liveOwners.add("terminal:pane-1");
  await assert.rejects(
    () => service.deleteAccount(sharedRow.id),
    (error) => error.name === "UnifiedAccountSessionsError" && error.sessionCount === 1,
  );
  assert.equal((await piStore.registry.snapshot()).defaults.xai, sharedRow.id, "a refused delete moves nothing");
  const deleted = await service.deleteAccount(sharedRow.id, { closeSessions: true });
  assert.deepEqual(deleted, { deleted: true, closedSessionCount: 1 });
  assert.deepEqual(disposed, [terminalOnly.profile.id]);
  releaseLease();
  assert.equal((await piStore.registry.snapshot()).defaults.xai, accountOne.id);
  assert.equal((await grokStore.snapshot()).defaultProfileId, "personal");
  assert.equal(await piStore.registry.getProfile(sharedRow.id), null);
  assert.equal(fs.existsSync(managedHome(terminalOnly.profile.id)), false);
  assert.equal(mirror.pairFor(sharedRow.id), undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(managedHome(terminalOnly.profile.id)), false, "a racing reconcile must not rebuild the half");
  assert.deepEqual((await grokStore.reconcile()).orphanProfileIds, []);
  pass("deleteAccount hands off to Account 1, respects leases, and removes the managed home");

  // A grok logout in ~/.grok signs Account 1 out of Cora; a new personal
  // login of another account that already has a managed row is rejected once.
  fs.rmSync(path.join(personalHome, "auth.json"));
  const signedOut = await service.reconcileProfile(accountOne.id);
  assert.ok(
    signedOut.wrote === "pi-delete" || signedOut.verdict === "none",
    JSON.stringify(signedOut),
  );
  assert.equal(readPi(accountOne.id), null);
  writeSlot(personalHome, slotFile(SUBJECT_A, 50));
  assert.ok(syncedInto(await service.reconcileProfile(accountOne.id), "pi"));
  assert.equal(readPi(accountOne.id).access, keyFor(SUBJECT_A, 50));
  pass("a personal logout signs Account 1 out of Cora and a new login signs it back in");

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
  visit(personalHome);
  assert.deepEqual(offending, []);
  pass("every produced file is owner-only");

  mirror.stop();
  service.stop();
  console.log(`\nPASS unified Grok account service (${passes} groups)`);
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
