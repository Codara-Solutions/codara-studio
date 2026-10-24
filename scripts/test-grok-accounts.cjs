#!/usr/bin/env node
"use strict";

// The unified account service over the Grok adapter, against real temp
// roots: a real Pi account store and registry, real per-account GROK_HOMEs
// under Codara's home, the real credential mirror and the REAL pinned Pi
// AuthStorage. The terminal session table is a stub; identities come from
// JWT claims. HOME is a fake home whose ~/.grok is the System login;
// nothing in it may change.
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
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.GROK_HOME;

const CLI_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
];
const SYSTEM_SUBJECT = "11111111-1111-4111-8111-111111111111";
const WORK_SUBJECT = "22222222-2222-4222-8222-222222222222";
const HOME_SUBJECT = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const fingerprintOf = (subject) => crypto.createHash("sha256").update(subject).digest("hex");
const SKEW = 5 * 60 * 1000;
const T0 = 1_900_000_000;
const SLOT = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const keyFor = (subject, n) =>
  jwt({ sub: subject, iat: T0 + n, exp: T0 + n + 3600, email: `${subject.slice(0, 8)}@example.com` });

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

  const slotFile = (subject, n) => ({
    [SLOT]: {
      key: keyFor(subject, n),
      auth_mode: "oidc",
      create_time: "2026-06-01T00:00:00.000Z",
      user_id: subject,
      email: `${subject.slice(0, 8)}@example.com`,
      principal_type: "User",
      principal_id: subject,
      refresh_token: `refresh-${subject.slice(0, 8)}-${n}`,
      expires_at: new Date((T0 + n + 3600) * 1000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    },
  });
  const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

  // The System login: the user's own ~/.grok, signed in as SYSTEM_SUBJECT.
  const systemHome = path.join(HOME, ".grok");
  privateFile(path.join(systemHome, "auth.json"), JSON.stringify(slotFile(SYSTEM_SUBJECT, 1)));
  privateFile(path.join(systemHome, "config.toml"), 'model = "grok-4"\n');
  privateFile(path.join(systemHome, "sessions", "one.json"), "{}\n");
  const ownBefore = snapshotTree(systemHome);

  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const grokRoot = path.join(HOME, ".codarastudio", "grok-cli");
  const homeOf = (cliId) => H.grokProfiles.grokCliManagedProfilePaths(grokRoot, cliId);
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.GrokCliProfileLeaseRegistry();
  let cliIndex = 0;
  const grokStore = new H.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: systemHome,
    leases,
    idFactory: () => CLI_IDS[cliIndex++],
  });
  const liveOwners = new Set();
  let defaultsChanged = 0;
  const logs = [];
  const makeService = () =>
    new H.accounts.UnifiedAccountService(
      H.grokAdapter.createGrokAccountAdapter({ store: grokStore, leases }),
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
        sessions: { liveOwnerIds: () => liveOwners },
        defaultsChanged: () => {
          defaultsChanged += 1;
        },
        log: (message) => logs.push(message),
      },
    );
  let service = makeService();
  assert.equal(service.provider, "xai");

  const piCredential = (subject, n) => ({
    type: "oauth",
    access: keyFor(subject, n),
    refresh: `refresh-${subject.slice(0, 8)}-${n}`,
    expires: (T0 + n + 3600) * 1000 - SKEW,
  });
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) => readJson(piAuthFile(coraId))?.xai ?? null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(authFile).modify("xai", async () => credential);
    fs.chmodSync(authFile, 0o600);
  };
  const connectCora = async (label, subject, n) => {
    const target = await piStore.prepareCredentialTarget({
      provider: "xai",
      label,
      identityFingerprint: fingerprintOf(subject),
    });
    await writePi(target.profile.id, piCredential(subject, n));
    return target.profile;
  };
  const defaults = async () => (await piStore.registry.snapshot()).defaults.xai;

  // --- The System login is offered, never adopted ----------------------------
  assert.deepEqual(await service.systemOffer(), { email: "11111111@example.com" });
  assert.deepEqual(await piStore.registry.listProfiles(), [], "an offer registers nothing");
  await service.dismissSystemOffer();
  assert.equal(await service.systemOffer(), null, "a dismissed offer stays hidden");
  assert.deepEqual(await piStore.registry.listProfiles(), []);
  const system = await service.addSystemAccount();
  assert.equal(system.cli.kind, "system");
  assert.equal(system.identityFingerprint, fingerprintOf(SYSTEM_SUBJECT));
  assert.equal(readPi(system.id), null);
  pass("the System login is offered and dismissible, and Use in Codara copies nothing");

  // --- A Cora sign-in becomes its own GROK_HOME --------------------------------
  const work = await connectCora("Work", WORK_SUBJECT, 5);
  const workCli = await service.ensureCliHalf(
    work.id,
    H.grokCodec.canonicalFromGrokPi(piCredential(WORK_SUBJECT, 5)),
  );
  const workHome = homeOf(workCli);
  assert.equal(workHome.homeDir, path.join(grokRoot, "accounts", workCli));
  const slot = readJson(workHome.authFile)[SLOT];
  assert.equal(slot.key, keyFor(WORK_SUBJECT, 5));
  assert.equal(slot.refresh_token, "refresh-22222222-5");
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(path.join(workHome.homeDir, "sessions")), path.join(systemHome, "sessions"));
    assert.equal(fs.lstatSync(path.join(workHome.homeDir, "config.toml")).isSymbolicLink(), false,
      "the config is a private copy, so Grok never writes through to the user's");
    assert.equal(fs.readFileSync(path.join(workHome.homeDir, "config.toml"), "utf8"), 'model = "grok-4"\n');
  }
  pass("a Cora sign-in becomes a GROK_HOME of its own with shared state linked");

  // Rotations flow both ways; a stranger's login is never adopted.
  privateFile(workHome.authFile, JSON.stringify(slotFile(WORK_SUBJECT, 10)));
  await service.reconcileCliProfile(workCli);
  assert.equal(readPi(work.id).access, keyFor(WORK_SUBJECT, 10));
  await writePi(work.id, piCredential(WORK_SUBJECT, 20));
  await service.reconcileProfile(work.id);
  assert.equal(readJson(workHome.authFile)[SLOT].key, keyFor(WORK_SUBJECT, 20));
  const piBefore = readPi(work.id);
  const before = fs.readFileSync(workHome.authFile, "utf8");
  privateFile(workHome.authFile, JSON.stringify(slotFile(STRANGER, 30)));
  assert.equal((await service.reconcileProfile(work.id)).verdict, "foreign");
  assert.deepEqual(readPi(work.id), piBefore);
  fs.writeFileSync(workHome.authFile, before, { mode: 0o600 });
  pass("rotations flow through the account's own auth.json and a stranger's login is refused");

  // --- Use: new sessions start in the account's home ---------------------------
  const homeRow = await connectCora("Home", HOME_SUBJECT, 7);
  const homeCli = await service.ensureCliHalf(
    homeRow.id,
    H.grokCodec.canonicalFromGrokPi(piCredential(HOME_SUBJECT, 7)),
  );
  defaultsChanged = 0;
  await service.useAccount(work.id);
  assert.equal(await defaults(), work.id);
  assert.equal((await grokStore.snapshot()).defaultProfileId, workCli);
  assert.equal((await grokStore.resolveProfile({ useDefault: true })).homeDir, workHome.homeDir);
  assert.ok(defaultsChanged >= 1, "the shell pointer is told to follow");
  const workBefore = fs.readFileSync(workHome.authFile, "utf8");
  await service.useAccount(homeRow.id);
  assert.equal((await grokStore.resolveProfile({ useDefault: true })).homeDir, homeOf(homeCli).homeDir);
  assert.equal(fs.readFileSync(workHome.authFile, "utf8"), workBefore, "a running Work session keeps its login");
  await service.useSystemLogin();
  assert.equal(await defaults(), system.id);
  assert.equal((await grokStore.resolveProfile({ useDefault: true })).homeDir, systemHome);
  await service.useAccount(work.id);
  pass("Use only changes which home new sessions start in");

  // --- Delete -------------------------------------------------------------------
  liveOwners.add("terminal:grok-pane");
  const release = leases.acquire(workCli, "terminal:grok-pane");
  const deleted = await service.deleteAccount(work.id);
  assert.deepEqual(deleted, { deleted: true, purgePending: true });
  assert.equal(await defaults(), undefined, "no other account is promoted");
  assert.equal(fs.existsSync(workHome.homeDir), true, "the running terminal keeps its home");
  assert.equal(fs.existsSync(workHome.authFile), false, "the login leaves the home at once");
  assert.deepEqual(await service.purgePending(), []);
  release();
  liveOwners.clear();
  assert.deepEqual(await service.purgePending(), [workHome.homeDir]);
  assert.equal(fs.existsSync(workHome.homeDir), false);
  assert.ok(await piStore.registry.isTombstoned("xai", { identityFingerprint: fingerprintOf(WORK_SUBJECT) }));
  assert.deepEqual(await service.deleteAccount(homeRow.id), { deleted: true, purgePending: false });
  assert.equal(fs.existsSync(homeOf(homeCli).homeDir), false);
  pass("delete tombstones the account and purges its home once no terminal holds it");

  // --- Restart: nothing comes back ---------------------------------------------
  service.stop();
  service = makeService();
  await service.clearDanglingLinks();
  await service.reprojectDefaults();
  await service.purgePending();
  assert.deepEqual((await piStore.registry.listProfiles()).map((profile) => profile.id), [system.id]);
  assert.equal((await grokStore.snapshot()).profiles.length, 0);
  pass("a restart resurrects nothing");

  assert.deepEqual(snapshotTree(systemHome), ownBefore, "~/.grok is byte-for-byte unchanged");
  pass("the user's own Grok home is never written");

  console.log(`\nPASS Grok accounts (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
