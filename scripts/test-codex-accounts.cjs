#!/usr/bin/env node
"use strict";

// The unified account service over the Codex adapter, against real temp
// roots: a real Pi account store and registry, real per-account CODEX_HOMEs
// under Codara's home, the real credential mirror and the REAL pinned Pi
// AuthStorage. The refresh grant is a stubbed fetch and the terminal session
// table is a stub; identities come from JWT claims. HOME is a fake home
// whose ~/.codex is the System login; nothing in it may change.
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
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = path.join(HOME, ".codarastudio");
delete process.env.CODEX_HOME;

const CLI_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
];
const SYSTEM_ACCOUNT = "acct-11111111-1111-4111-8111-111111111111";
const WORK_ACCOUNT = "acct-22222222-2222-4222-8222-222222222222";
const HOME_ACCOUNT = "acct-33333333-3333-4333-8333-333333333333";
const STRANGER = "acct-44444444-4444-4444-8444-444444444444";
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

function mode(file) {
  return fs.statSync(file).mode & 0o777;
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

  const authFile = (accountId, n) => ({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idTokenFor(accountId, n),
      access_token: accessFor(accountId, n),
      refresh_token: `refresh-${accountId.slice(5, 13)}-${n}`,
      account_id: accountId,
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
  });
  const writeFile = (file, value) => privateFile(file, JSON.stringify(value, null, 2));
  const readFile = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

  // The System login: the user's own ~/.codex, signed in as SYSTEM_ACCOUNT,
  // with the shared state a real Codex home carries.
  const systemHome = path.join(HOME, ".codex");
  writeFile(path.join(systemHome, "auth.json"), authFile(SYSTEM_ACCOUNT, 1));
  privateFile(path.join(systemHome, "config.toml"), 'model = "gpt-5"\n');
  privateFile(path.join(systemHome, "sessions", "2026", "rollout.jsonl"), "{}\n");
  const ownBefore = snapshotTree(systemHome);

  const piRoot = path.join(HOME, ".codarastudio", "pi-agent");
  const codexRoot = path.join(HOME, ".codarastudio", "codex-cli");
  const homeOf = (cliId) => H.codexProfiles.codexCliManagedProfilePaths(codexRoot, cliId);
  const piStore = new H.piStore.PiAccountAuthStore(piRoot);
  const leases = new H.execution.CodexCliProfileLeaseRegistry();
  let cliIndex = 0;
  const codexStore = new H.codexProfiles.CodexCliAccountProfileStore(codexRoot, {
    personalHomeDir: systemHome,
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
  const logs = [];
  const liveOwners = new Set();
  let defaultsChanged = 0;
  const makeService = () =>
    new H.accounts.UnifiedAccountService(
      H.codexAdapter.createCodexAccountAdapter({
        store: codexStore,
        leases,
        loadAuthStorage,
        fetchImpl,
        now: () => new Date("2026-08-30T12:00:00.000Z"),
        log: (message) => logs.push(message),
      }),
      {
        piStore,
        mirror: new H.mirror.CredentialMirror({
          loadAuthStorage,
          pollWhenWatchBlind: null,
          debounceMs: 30,
          retryDelayMs: 20,
          log: (message) => logs.push(message),
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
  assert.equal(service.provider, "openai-codex");

  const piCredential = (accountId, n, extra = {}) => ({
    type: "oauth",
    access: accessFor(accountId, n),
    refresh: `refresh-${accountId.slice(5, 13)}-${n}`,
    expires: (T0 + n + LIFETIME) * 1000 - 12345,
    accountId,
    ...extra,
  });
  const piAuthFile = (coraId) => H.piStore.piAccountProfilePaths(piRoot, coraId).authFile;
  const readPi = (coraId) => readFile(piAuthFile(coraId))?.["openai-codex"] ?? null;
  const writePi = async (coraId, credential) => {
    const { configDir, authFile: target } = H.piStore.piAccountProfilePaths(piRoot, coraId);
    privateDir(configDir);
    await AuthStorage.create(target).modify("openai-codex", async () => credential);
    fs.chmodSync(target, 0o600);
  };
  const connectCora = async (label, accountId, credential) => {
    const target = await piStore.prepareCredentialTarget({
      provider: "openai-codex",
      label,
      identityFingerprint: fingerprintOf(accountId),
    });
    await writePi(target.profile.id, credential);
    return target.profile;
  };
  const defaults = async () => (await piStore.registry.snapshot()).defaults["openai-codex"];

  // --- The System login is offered, never adopted ----------------------------
  assert.deepEqual(await piStore.registry.listProfiles(), []);
  assert.deepEqual(await service.systemOffer(), { email: "11111111@example.com" });
  assert.deepEqual(await piStore.registry.listProfiles(), [], "an offer registers nothing");
  const system = await service.addSystemAccount();
  assert.equal(system.cli.kind, "system");
  assert.equal(system.cora, "none");
  assert.equal(system.identityFingerprint, fingerprintOf(SYSTEM_ACCOUNT));
  assert.equal(readPi(system.id), null, "nothing of the System login is copied to Cora");
  assert.equal(await service.systemOffer(), null);
  pass("the System login is offered, and Use in Codara adds a row without copying its login");

  // --- A Cora sign-in grows its own CODEX_HOME --------------------------------
  // Codex insists on an id_token, which only a refresh grant returns. A
  // refused grant leaves the row Cora-only and no home behind.
  const work = await connectCora("Work", WORK_ACCOUNT, piCredential(WORK_ACCOUNT, 5));
  const workCanonical = H.codexCodec.canonicalFromCodexPi(piCredential(WORK_ACCOUNT, 5));
  await assert.rejects(() => service.ensureCliHalf(work.id, workCanonical), /refused \(429\)/);
  assert.equal((await piStore.registry.getProfile(work.id)).cliProfileId, undefined);
  assert.equal((await codexStore.snapshot()).profiles.length, 0, "no half-built home");
  assert.equal(fs.existsSync(homeOf(CLI_IDS[0]).profileDir), false);
  grantResponse = (body) => {
    assert.equal(body.grant_type, "refresh_token");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: accessFor(WORK_ACCOUNT, 6),
          refresh_token: "refresh-22222222-6",
          id_token: idTokenFor(WORK_ACCOUNT, 6),
          expires_in: LIFETIME,
        }),
    };
  };
  const workCli = await service.ensureCliHalf(work.id, workCanonical);
  assert.equal(workCli, CLI_IDS[0], "a refused grant never reached the store");
  assert.equal(grants.at(-1).body.refresh_token, "refresh-22222222-5", "the grant used Pi's refresh token");
  assert.equal(readPi(work.id).refresh, "refresh-22222222-6", "the rotated refresh token reached Pi first");
  const workHome = homeOf(workCli);
  assert.equal(workHome.homeDir, path.join(codexRoot, "accounts", workCli, "home"));
  const workAuth = readFile(workHome.authFile);
  assert.equal(workAuth.tokens.account_id, WORK_ACCOUNT);
  assert.equal(workAuth.tokens.id_token, idTokenFor(WORK_ACCOUNT, 6));
  assert.equal(mode(workHome.authFile), 0o600);
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(path.join(workHome.homeDir, "config.toml")), path.join(systemHome, "config.toml"));
    assert.equal(fs.readlinkSync(path.join(workHome.homeDir, "sessions")), path.join(systemHome, "sessions"));
    assert.equal(fs.lstatSync(workHome.authFile).isSymbolicLink(), false, "auth.json is the home's own");
  }
  assert.equal((await piStore.registry.getProfile(work.id)).cora, "linked");
  pass("a Cora sign-in grows its own CODEX_HOME with shared state linked and a private auth.json");

  // Rotations flow both ways through the account's own auth.json.
  writeFile(workHome.authFile, authFile(WORK_ACCOUNT, 10));
  await service.reconcileCliProfile(workCli);
  assert.equal(readPi(work.id).access, accessFor(WORK_ACCOUNT, 10));
  await writePi(work.id, piCredential(WORK_ACCOUNT, 20));
  await service.reconcileProfile(work.id);
  const rotated = readFile(workHome.authFile);
  assert.equal(rotated.tokens.access_token, accessFor(WORK_ACCOUNT, 20));
  assert.equal(rotated.tokens.id_token, idTokenFor(WORK_ACCOUNT, 10), "id_token survives a Pi rotation");
  pass("rotations flow between Cora and the account's own auth.json");

  // A stranger's `codex login` inside Work's home is never adopted.
  {
    const piBefore = readPi(work.id);
    const before = fs.readFileSync(workHome.authFile, "utf8");
    writeFile(workHome.authFile, authFile(STRANGER, 30));
    const foreign = await service.reconcileProfile(work.id);
    assert.equal(foreign.verdict, "foreign");
    assert.deepEqual(readPi(work.id), piBefore);
    fs.writeFileSync(workHome.authFile, before, { mode: 0o600 });
    pass("another account's login in a managed home is neither mirrored nor overwritten");
  }

  // A Cora credential that already carries an id_token needs no grant.
  const grantsBefore = grants.length;
  const homeRow = await connectCora(
    "Home",
    HOME_ACCOUNT,
    piCredential(HOME_ACCOUNT, 7, { idToken: idTokenFor(HOME_ACCOUNT, 7) }),
  );
  const homeCli = await service.ensureCliHalf(
    homeRow.id,
    H.codexCodec.canonicalFromCodexPi(readPi(homeRow.id)),
  );
  assert.equal(grants.length, grantsBefore);
  assert.equal(readFile(homeOf(homeCli).authFile).tokens.account_id, HOME_ACCOUNT);
  pass("a Cora credential with an id_token becomes a Codex home without a grant");

  // --- Use: new sessions start in the account's home ---------------------------
  const workAuthBefore = fs.readFileSync(workHome.authFile, "utf8");
  defaultsChanged = 0;
  await service.useAccount(work.id);
  assert.equal(await defaults(), work.id);
  assert.equal((await codexStore.snapshot()).defaultProfileId, workCli);
  assert.equal((await codexStore.resolveProfile({ useDefault: true })).homeDir, workHome.homeDir);
  assert.ok(defaultsChanged >= 1, "the shell pointer is told to follow");
  await service.useAccount(homeRow.id);
  assert.equal((await codexStore.resolveProfile({ useDefault: true })).homeDir, homeOf(homeCli).homeDir);
  assert.equal(
    fs.readFileSync(workHome.authFile, "utf8"),
    workAuthBefore,
    "a session already running in Work's home keeps its account",
  );
  assert.equal(fs.existsSync(path.join(codexRoot, "active-auth.json")), false, "there is no Codex live slot");
  await service.useSystemLogin();
  assert.equal(await defaults(), system.id);
  const resolvedSystem = await codexStore.resolveProfile({ useDefault: true });
  assert.equal(resolvedSystem.profileId, "personal");
  assert.equal(resolvedSystem.homeDir, systemHome);
  await service.useAccount(work.id);
  pass("Use only changes which home new sessions start in; running sessions keep theirs");

  // --- Delete: a home a terminal still runs in is purged when it exits -------
  liveOwners.add("terminal:codex-pane");
  const release = leases.acquire(workCli, "terminal:codex-pane");
  const deleted = await service.deleteAccount(work.id);
  assert.deepEqual(deleted, { deleted: true, purgePending: true });
  assert.equal(await piStore.registry.getProfile(work.id), null);
  assert.equal(await defaults(), undefined, "no other account is promoted");
  assert.equal((await codexStore.snapshot()).defaultProfileId, "personal");
  assert.equal(fs.existsSync(workHome.homeDir), true, "the running terminal keeps its home");
  assert.equal(fs.existsSync(workHome.authFile), false, "the login leaves the home at once");
  const queued = (await piStore.registry.snapshot()).pendingPurge;
  assert.deepEqual(queued.map((entry) => entry.path), [workHome.profileDir]);
  assert.deepEqual(await service.purgePending(), [], "a held home waits");
  release();
  liveOwners.clear();
  assert.deepEqual(await service.purgePending(), [workHome.profileDir]);
  assert.equal(fs.existsSync(workHome.profileDir), false);
  assert.deepEqual((await piStore.registry.snapshot()).pendingPurge, []);
  assert.ok(await piStore.registry.isTombstoned("openai-codex", { identityFingerprint: fingerprintOf(WORK_ACCOUNT) }));
  pass("delete tombstones the account and purges its home once the last terminal exits");

  // A home with no terminal goes at once.
  const deletedHome = await service.deleteAccount(homeRow.id);
  assert.deepEqual(deletedHome, { deleted: true, purgePending: false });
  assert.equal(fs.existsSync(homeOf(homeCli).profileDir), false);
  pass("a home no terminal holds is purged at once");

  // --- Restart: nothing comes back ---------------------------------------------
  service.stop();
  service = makeService();
  await service.clearDanglingLinks();
  await service.reprojectDefaults();
  await service.purgePending();
  assert.deepEqual(
    (await piStore.registry.listProfiles()).map((profile) => profile.id),
    [system.id],
    "deleted accounts stay deleted across a restart",
  );
  assert.equal((await codexStore.snapshot()).profiles.length, 0);
  pass("a restart resurrects nothing");

  // Deleting the System row only forgets it.
  await service.deleteAccount(system.id);
  assert.equal(await service.systemOffer(), null, "a deleted System row's offer stays hidden");
  pass("deleting the System row only forgets it");

  // --- The user's own Codex home -----------------------------------------------
  assert.deepEqual(snapshotTree(systemHome), ownBefore, "~/.codex is byte-for-byte unchanged");
  pass("the user's own Codex home is never written");

  console.log(`\nPASS Codex accounts (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
