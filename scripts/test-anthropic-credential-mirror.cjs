#!/usr/bin/env node
"use strict";

// The provider-generic credential mirror over the Claude adapter, driven
// against real temp directories and the REAL pinned Pi AuthStorage
// (proper-lockfile and all). Claude accounts live in one home: the live
// profile's login is the home's credential store and every other profile's
// login is its vault. The Keychain is off, so the live store is the home's
// `.credentials.json` and no real item is touched.
//
//   node scripts/test-anthropic-credential-mirror.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PI_PACKAGE_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-credential-mirror-"));
const OUT = path.join(TMP, "mirror.cjs");
const CORA_ID = "11111111-1111-4111-8111-111111111111";
const CLI_ID = "22222222-2222-4222-8222-222222222222";
const PADDING = 5 * 60 * 1000;
process.env.CODARA_DISABLE_KEYCHAIN = "1";
process.env.CODARA_HOME_DIR = path.join(TMP, "codara-home");
delete process.env.CLAUDE_CONFIG_DIR;

const stubPlugin = {
  name: "mirror-harness",
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
      contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); } export async function resolveCodaraPiLibrary() { throw new Error("not used"); }`,
    }));
  },
};

async function loadAuthStorage() {
  const loaded = await import(
    pathToFileURL(path.join(PI_PACKAGE_ROOT, "dist", "core", "auth-storage.js")).href
  );
  return loaded.AuthStorage;
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

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);
  const entry = path.join(TMP, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(orchestration("credential-mirror.ts"))};`,
      `export * as codec from ${JSON.stringify(orchestration("account-adapters/claude-credential-codec.ts"))};`,
      `export * as claudeAdapter from ${JSON.stringify(orchestration("account-adapters/claude-account-adapter.ts"))};`,
      `export * as claudeStores from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
    ].join("\n"),
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUT,
    external: ["electron"],
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  const mod = require(OUT);
  const codec = mod.codec;
  const AuthStorage = await loadAuthStorage();

  // Every pair gets its own Claude home and account store. A managed pair's
  // CLI half is its vault until the marker names it live; Account 1's is the
  // live home until another profile takes the slot.
  let pairIndex = 0;
  function makePair(options = {}) {
    pairIndex += 1;
    const root = path.join(TMP, `pair-${pairIndex}`);
    const piDir = path.join(root, "pi", CORA_ID);
    const cliId = options.personal ? "personal" : CLI_ID;
    const home = path.join(root, "home");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "claude-cli"), { recursive: true, mode: 0o700 });
    const store = new mod.claudeStores.ClaudeCliAccountProfileStore(path.join(root, "claude-cli"), {
      personalConfigDir: configDir,
      personalConfigDirEnv: null,
      idFactory: () => CLI_ID,
      authChecker: () => ({ connected: true }),
    });
    const adapter = mod.claudeAdapter.createClaudeAccountAdapter({
      store,
      fileOnly: true,
      platform: "linux",
    });
    const pair = {
      provider: "anthropic",
      coraProfileId: CORA_ID,
      cliProfileId: cliId,
      authFile: path.join(piDir, "auth.json"),
      location: adapter.locate(cliId),
      adapter,
    };
    const meta = {
      root,
      home,
      configDir,
      store,
      liveFile: path.join(configDir, ".credentials.json"),
      identityFile: path.join(home, ".claude.json"),
      markerFile: path.join(root, "claude-cli", "live-login.json"),
    };
    pairs.set(pair, meta);
    return { pair, meta, ready: options.personal ? Promise.resolve() : store.createProfile({ label: "Managed" }) };
  }
  const pairs = new Map();
  const metaOf = (pair) => {
    for (const [known, meta] of pairs) if (known.authFile === pair.authFile) return meta;
    throw new Error("unknown pair");
  };
  const isLive = (pair) => {
    const meta = metaOf(pair);
    const marker = fs.existsSync(meta.markerFile)
      ? JSON.parse(fs.readFileSync(meta.markerFile, "utf8")).profileId
      : "personal";
    return marker === pair.cliProfileId;
  };
  const makeLive = (pair) => {
    fs.writeFileSync(
      metaOf(pair).markerFile,
      JSON.stringify({ version: 1, profileId: pair.cliProfileId }),
      { mode: 0o600 },
    );
  };
  const writePi = (pair, credential) => {
    if (credential === null) {
      fs.rmSync(pair.authFile, { force: true });
      return;
    }
    fs.writeFileSync(pair.authFile, JSON.stringify({ anthropic: credential }), { mode: 0o600 });
    fs.chmodSync(pair.authFile, 0o600);
  };
  const readPi = (pair) =>
    fs.existsSync(pair.authFile)
      ? JSON.parse(fs.readFileSync(pair.authFile, "utf8")).anthropic ?? null
      : null;
  const writeClaude = (pair, record, extras = {}) => {
    const file = isLive(pair) ? metaOf(pair).liveFile : pair.location.vaultFile;
    if (record === null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = isLive(pair)
      ? { ...extras, claudeAiOauth: record }
      : { version: 1, store: { claudeAiOauth: record } };
    fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  const readClaude = (pair) =>
    pair.adapter.readCli(pair.location).then((side) => (side.kind === "credential" ? side.raw : side));
  const reconcile = (pair, extra = {}) =>
    mod.reconcilePair(pair, { loadAuthStorage, retryDelayMs: 20, ...extra });
  const withReadCli = (pair, readCli) => ({
    ...pair,
    adapter: { ...pair.adapter, readCli },
  });

  const T0 = 1_800_000_000_000;
  const pi = (n, extra = {}) => ({
    type: "oauth",
    access: `pi-access-${n}`,
    refresh: `pi-refresh-${n}`,
    expires: T0 + n * 1000 - PADDING,
    ...extra,
  });
  const claude = (n, extra = {}) => ({
    accessToken: `claude-access-${n}`,
    refreshToken: `claude-refresh-${n}`,
    expiresAt: T0 + n * 1000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    ...extra,
  });
  async function managedPair() {
    const made = makePair();
    await made.ready;
    return made;
  }

  // Pure core.
  {
    const canonical = { access: "a", refresh: "r", expiresAt: T0 };
    assert.deepEqual(codec.canonicalFromPi(codec.piRecordFromCanonical(canonical)), canonical);
    assert.deepEqual(
      codec.canonicalFromClaude(codec.claudeRecordFromCanonical(canonical)),
      canonical,
    );
    assert.equal(codec.piRecordFromCanonical(canonical).expires, T0 - PADDING);
    assert.deepEqual(codec.claudeRecordFromCanonical(canonical).scopes, [
      ...codec.ANTHROPIC_OAUTH_SCOPES,
    ]);
    const carried = codec.claudeRecordFromCanonical(canonical, claude(1, { rateLimitTier: "t" }));
    assert.equal(carried.subscriptionType, "max");
    assert.equal(carried.rateLimitTier, "t");
    assert.deepEqual(carried.scopes, ["user:inference"]);
    assert.equal(codec.canonicalFromPi({ type: "api_key", key: "x" }), null);
    assert.equal(codec.canonicalFromClaude(null), null);
    assert.equal(codec.claudeCredentialCodec.provider, "anthropic");
    assert.deepEqual(
      codec.claudeCredentialCodec.canonicalFromCli(codec.claudeCredentialCodec.cliRecordFromCanonical(canonical, null)),
      canonical,
    );
    pass("conversions round-trip and carry Claude-only fields without inventing them");

    const c = (n, refresh = `r${n}`) => ({ access: `a${n}`, refresh, expiresAt: T0 + n });
    assert.equal(mod.compareCredentials(null, null), "none");
    assert.equal(mod.compareCredentials(c(1), null), "pi-only");
    assert.equal(mod.compareCredentials(null, c(1)), "cli-only");
    assert.equal(mod.compareCredentials(c(2), c(1)), "pi-newer");
    assert.equal(mod.compareCredentials(c(1), c(2)), "cli-newer");
    assert.equal(mod.compareCredentials(c(1), c(1)), "equal");
    assert.equal(mod.compareCredentials(c(1), { ...c(1), access: "other" }), "conflict");
    assert.equal(mod.compareCredentials(c(9, ""), c(1)), "cli-newer");
    assert.equal(mod.compareCredentials(c(1), c(9, "")), "pi-newer");
    assert.equal(mod.compareCredentials(c(1, ""), c(2, "")), "cli-newer");
    // The same access token is in sync whatever each side's expiry says
    // (Pi's client-clock expiry drifts from a JWT's exp), and an equal
    // expiry is decided by the issue time when both sides report one.
    assert.equal(mod.compareCredentials(c(1), { ...c(1), expiresAt: T0 + 500, refresh: "other" }), "equal");
    assert.equal(mod.compareCredentials({ ...c(1), issuedAt: 20 }, { ...c(1), access: "b", issuedAt: 10 }), "pi-newer");
    assert.equal(mod.compareCredentials({ ...c(1), issuedAt: 10 }, { ...c(1), access: "b", issuedAt: 20 }), "cli-newer");
    assert.equal(mod.compareCredentials({ ...c(1), issuedAt: 10 }, { ...c(1), access: "b", issuedAt: 10 }), "conflict");
    assert.equal(mod.compareCredentials({ ...c(1), issuedAt: 10 }, { ...c(1), access: "b" }), "conflict");
    pass("comparison: identical access first, strict expiry, refresh precedence, issuedAt tie-break, conflict");
  }

  // Fresher Pi wins: the Claude side gets the token, its own fields survive.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(5));
    writeClaude(pair, claude(3, { rateLimitTier: "tier" }));
    const result = await reconcile(pair);
    assert.equal(result.verdict, "pi-newer");
    assert.equal(result.wrote, "cli");
    const after = await readClaude(pair);
    assert.equal(after.accessToken, "pi-access-5");
    assert.equal(after.refreshToken, "pi-refresh-5");
    assert.equal(after.expiresAt, T0 + 5000);
    assert.deepEqual(after.scopes, ["user:inference"]);
    assert.equal(after.subscriptionType, "max");
    assert.equal(after.rateLimitTier, "tier");
    assert.deepEqual(readPi(pair), pi(5), "the winning side is untouched");
    assert.equal(mode(pair.location.vaultFile), 0o600);
    const again = await reconcile(pair);
    assert.equal(again.verdict, "equal");
    assert.equal(again.wrote, null);
    pass("a fresher Pi token flows to Claude Code and the pair is then in sync");
  }

  // The live slot keeps its MCP grants when the mirror writes the login.
  {
    const { pair, meta } = await managedPair();
    makeLive(pair);
    writePi(pair, pi(5));
    const extras = { mcpOAuth: { server: { accessToken: "mcp-live", refreshToken: "mcp-refresh" } } };
    writeClaude(pair, claude(3), extras);
    assert.equal((await reconcile(pair)).wrote, "cli");
    const raw = JSON.parse(fs.readFileSync(meta.liveFile, "utf8"));
    assert.deepEqual(raw.mcpOAuth, extras.mcpOAuth);
    assert.equal(raw.claudeAiOauth.accessToken, "pi-access-5");
    assert.equal(
      JSON.parse(fs.readFileSync(pair.location.vaultFile, "utf8")).store.claudeAiOauth.accessToken,
      "pi-access-5",
      "the vault copy trails the live slot",
    );
    assert.equal(readPi(pair).mcpOAuth, undefined, "MCP grants never enter Pi account credentials");
    pass("the live slot preserves MCP grants during a mirror reconciliation");
  }

  // Identity crossover: the user logs the live home into a different
  // account. Claude's tokens are opaque, so the slot's identity record is the
  // only witness; without consulting it the row would adopt a stranger's
  // login as its Cora half and every card would show that account's usage.
  {
    const { pair, meta } = makePair({ personal: true });
    const owned = { ...pair, identityFingerprint: "fp-own-account" };
    writePi(owned, pi(2));
    writeClaude(owned, claude(9));

    // Same account: the fresher CLI token still flows to Cora.
    fs.writeFileSync(meta.identityFile, JSON.stringify({ oauthAccount: { accountUuid: "own" } }));
    const sameAccount = await reconcile({
      ...owned,
      adapter: { ...owned.adapter, cliIdentityFingerprint: async () => "fp-own-account" },
    });
    assert.equal(sameAccount.verdict, "cli-newer");
    assert.equal(sameAccount.wrote, "pi");

    // Another account in the same slot: nothing moves, in either direction.
    writePi(owned, pi(2));
    writeClaude(owned, claude(9));
    const foreignAdapter = { ...owned.adapter, cliIdentityFingerprint: async () => "fp-someone-else" };
    const stranger = await reconcile({ ...owned, adapter: foreignAdapter });
    assert.equal(stranger.verdict, "foreign");
    assert.equal(stranger.wrote, null);
    assert.deepEqual(readPi(owned), pi(2), "the row keeps its own Cora credential");
    assert.equal((await readClaude(owned)).accessToken, "claude-access-9", "the stranger's login is left alone");

    // A fresher Cora half must not overwrite the stranger's slot either.
    writePi(owned, pi(20));
    const outward = await reconcile({ ...owned, adapter: foreignAdapter });
    assert.equal(outward.verdict, "foreign");
    assert.equal(outward.wrote, null);
    assert.equal((await readClaude(owned)).accessToken, "claude-access-9");

    // The real adapter reads that identity from the live home's
    // .claude.json, so the wiring, not just the mirror rule, is pinned here.
    fs.writeFileSync(meta.identityFile, JSON.stringify({ oauthAccount: { accountUuid: "own-uuid" } }));
    const ownFingerprint = await owned.adapter.cliIdentityFingerprint(owned.location);
    assert.ok(ownFingerprint, "the adapter reads the slot's identity");
    writePi(owned, pi(2));
    writeClaude(owned, claude(9));
    const mine = await reconcile({ ...owned, identityFingerprint: ownFingerprint });
    assert.equal(mine.verdict, "cli-newer", "the row's own login still mirrors");
    fs.writeFileSync(meta.identityFile, JSON.stringify({ oauthAccount: { accountUuid: "other-uuid" } }));
    writePi(owned, pi(2));
    writeClaude(owned, claude(9));
    const theirs = await reconcile({ ...owned, identityFingerprint: ownFingerprint });
    assert.equal(theirs.verdict, "foreign", "a re-login into another account is refused");
    assert.deepEqual(readPi(owned), pi(2));

    // An unreadable identity is not a verdict: a healthy pair keeps working.
    writePi(owned, pi(2));
    const unknown = await reconcile({
      ...owned,
      adapter: { ...owned.adapter, cliIdentityFingerprint: async () => undefined },
    });
    assert.equal(unknown.verdict, "cli-newer");
    assert.equal(unknown.wrote, "pi");
    pass("a slot logged into another account is never adopted, in either direction");
  }

  // Fresher Claude wins: the Pi side is rewritten under Pi's lock with the
  // padding re-applied, and the auth file stays owner-only.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(2));
    writeClaude(pair, claude(7));
    const result = await reconcile(pair);
    assert.equal(result.verdict, "cli-newer");
    assert.equal(result.wrote, "pi");
    assert.deepEqual(readPi(pair), {
      type: "oauth",
      access: "claude-access-7",
      refresh: "claude-refresh-7",
      expires: T0 + 7000 - PADDING,
    });
    assert.equal(mode(pair.authFile), 0o600);
    assert.equal((await readClaude(pair)).accessToken, "claude-access-7");
    pass("a fresher Claude token flows to Pi through AuthStorage with the expiry padding");
  }

  // Never lowers an expiry, in sync is a no-op, conflict is a no-op.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(4));
    writeClaude(pair, claude(4, { accessToken: "pi-access-4", refreshToken: "pi-refresh-4" }));
    assert.equal((await reconcile(pair)).wrote, null);
    writeClaude(pair, claude(4));
    const conflict = await reconcile(pair);
    assert.equal(conflict.verdict, "conflict");
    assert.equal(conflict.wrote, null);
    assert.deepEqual(readPi(pair), pi(4));
    assert.equal((await readClaude(pair)).accessToken, "claude-access-4");
    // The next rotation on either side breaks the tie.
    writeClaude(pair, claude(6));
    assert.equal((await reconcile(pair)).wrote, "pi");
    assert.equal(readPi(pair).access, "claude-access-6");
    pass("in-sync and conflicting pairs are left alone; the next rotation resolves a conflict");
  }

  // A side without a refresh token never wins.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(1));
    writeClaude(pair, claude(9, { refreshToken: "" }));
    const result = await reconcile(pair);
    assert.equal(result.verdict, "pi-newer");
    assert.equal((await readClaude(pair)).refreshToken, "pi-refresh-1");
    pass("a refreshable side beats a fresher side with no refresh token");
  }

  // Missing sides are copied for a managed pair, in both directions.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(3));
    assert.equal((await reconcile(pair)).wrote, "cli");
    const created = await readClaude(pair);
    assert.equal(created.accessToken, "pi-access-3");
    assert.deepEqual(created.scopes, [...codec.ANTHROPIC_OAUTH_SCOPES]);
    assert.equal("subscriptionType" in created, false);
    const { pair: other } = await managedPair();
    writeClaude(other, claude(3));
    assert.equal((await reconcile(other)).wrote, "pi");
    assert.equal(readPi(other).access, "claude-access-3");
    assert.equal(mode(other.authFile), 0o600);
    pass("a missing managed side is created from the other half");
  }

  // Account 1 while live: the user's own login is never created there, and a
  // logout (`/logout` removes the record) signs Cora out only when the
  // previous observation had a credential.
  {
    const { pair } = makePair({ personal: true });
    writePi(pair, pi(3));
    let result = await reconcile(pair);
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, null);
    assert.equal(await readClaude(pair), null, "the mirror never creates the live home's login");
    assert.deepEqual(readPi(pair), pi(3));
    result = await reconcile(pair, { previousCliPresent: false });
    assert.equal(result.wrote, null);
    result = await reconcile(pair, { previousCliPresent: true });
    assert.equal(result.wrote, "pi-delete");
    assert.equal(readPi(pair), null, "a claude logout signs Account 1 out of Cora");
    assert.equal(mode(pair.authFile), 0o600);
    // The reverse direction never deletes: a missing Pi side with a live
    // login simply gets the credential copied to Pi.
    writeClaude(pair, claude(2));
    result = await reconcile(pair, { previousCliPresent: true });
    assert.equal(result.wrote, "pi");
    assert.equal(readPi(pair).access, "claude-access-2");
    // An existing live login IS updated.
    writePi(pair, pi(8));
    assert.equal((await reconcile(pair)).wrote, "cli");
    assert.equal((await readClaude(pair)).accessToken, "pi-access-8");
    pass("Account 1 while live: no creation, logout propagates one way only");
  }

  // Claude Code blanks a login whose refresh token another holder already
  // rotated. That is not a logout: Cora keeps its half and repairs the slot.
  {
    const { pair } = makePair({ personal: true });
    writePi(pair, pi(6));
    writeClaude(pair, { ...claude(4), accessToken: "", refreshToken: "", expiresAt: 0 });
    const result = await reconcile(pair, { previousCliPresent: true });
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, "cli", "the dead login is repaired from the fresher half");
    assert.deepEqual(readPi(pair), pi(6), "Cora is not signed out");
    const repaired = await readClaude(pair);
    assert.equal(repaired.accessToken, "pi-access-6");
    assert.equal(repaired.subscriptionType, "max", "the blanked record's own fields survive");
    pass("a login Claude Code blanked after a spent refresh is repaired, never propagated as a logout");
  }

  // Account 1 while another account is live: its vault is Codara's, so the
  // Cora half rebuilds it.
  {
    const { pair, ready } = makePair({ personal: true });
    await ready;
    fs.writeFileSync(
      pairs.get(pair).markerFile,
      JSON.stringify({ version: 1, profileId: CLI_ID }),
      { mode: 0o600 },
    );
    writePi(pair, pi(4));
    const result = await reconcile(pair);
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, "cli");
    assert.equal((await readClaude(pair)).accessToken, "pi-access-4");
    assert.equal(fs.existsSync(pairs.get(pair).liveFile), false, "the live home is untouched");
    pass("Account 1's vault is rebuilt from Cora while another account is live");
  }

  // A half-written file is retried, not treated as signed out.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(5));
    writeClaude(pair, claude(2));
    fs.writeFileSync(pair.authFile, '{"anthropic":{"type":"oauth","acc', { mode: 0o600 });
    const repair = setTimeout(() => writePi(pair, pi(5)), 60);
    const result = await reconcile(pair);
    clearTimeout(repair);
    assert.equal(result.verdict, "pi-newer");
    assert.equal((await readClaude(pair)).accessToken, "pi-access-5");
    fs.writeFileSync(pair.authFile, "{{{{", { mode: 0o600 });
    const stuck = await reconcile(pair);
    assert.equal(stuck.verdict, "unreadable");
    assert.equal(stuck.wrote, null);
    assert.equal((await readClaude(pair)).accessToken, "pi-access-5");
    pass("unreadable input is retried and never written over");
  }

  // Lock interplay: a Pi refresh holding AuthStorage's lock while the mirror
  // reconciles must win, because the comparison is repeated under the lock.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(1));
    writeClaude(pair, claude(5));
    const storage = AuthStorage.create(pair.authFile);
    let releaseRefresh;
    const refreshing = storage.modify("anthropic", async () => {
      await new Promise((resolve) => {
        releaseRefresh = resolve;
      });
      return pi(9);
    });
    await waitFor(() => Boolean(releaseRefresh));
    const reconciling = reconcile(pair);
    await sleep(150);
    releaseRefresh();
    await refreshing;
    const result = await reconciling;
    assert.equal(result.wrote, null, "the reconcile must not undo the refresh that beat it");
    assert.deepEqual(readPi(pair), pi(9));
    // The next reconcile carries the fresher Pi token over to Claude.
    assert.equal((await reconcile(pair)).wrote, "cli");
    assert.equal((await readClaude(pair)).accessToken, "pi-access-9");
    pass("a concurrent Pi refresh under the lock is never clobbered");
  }

  // A terminal refresh that lands between the mirror's read and its write
  // must win, or both halves end up holding a refresh token Anthropic
  // already rotated away.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(5));
    writeClaude(pair, claude(3));
    let reads = 0;
    const racing = withReadCli(pair, async (location) => {
      reads += 1;
      if (reads === 2) writeClaude(pair, claude(9));
      return pair.adapter.readCli(location);
    });
    const result = await mod.reconcilePair(racing, { loadAuthStorage, retryDelayMs: 20 });
    assert.equal(result.wrote, null, "the stale comparison must not be written");
    assert.equal(result.verdict, "cli-newer");
    assert.equal((await readClaude(pair)).accessToken, "claude-access-9");
    assert.equal((await reconcile(pair)).wrote, "pi");
    assert.equal(readPi(pair).access, "claude-access-9");
    pass("a Claude refresh that lands before the mirror's write wins and flows to Pi next");
  }

  // Unwatching a pair mid-reconcile: the reads finish, the write is refused,
  // and the caller can wait for the drain before removing the files.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(7));
    writeClaude(pair, claude(2));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let gated = false;
    const slow = withReadCli(pair, async (location) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return pair.adapter.readCli(location);
    });
    const mirror = new mod.CredentialMirror({
      loadAuthStorage,
      pollWhenWatchBlind: null,
      debounceMs: 40,
      retryDelayMs: 20,
    });
    mirror.watch(slow);
    const inflight = mirror.reconcileNow(CORA_ID);
    await waitFor(() => gated);
    const drained = mirror.unwatch(CORA_ID);
    release();
    await drained;
    const cancelled = await inflight;
    assert.equal(cancelled.verdict, "pi-newer", "the reads landed");
    assert.equal(cancelled.wrote, null, "the write was refused");
    assert.equal((await readClaude(pair)).accessToken, "claude-access-2", "no write after unwatch");
    assert.deepEqual(readPi(pair), pi(7));
    mirror.stop();
    pass("an unwatched pair mid-reconcile lands its reads and refuses its write");
  }

  // A managed profile whose directory vanished between the read and the
  // write (an account mid-delete) is never re-created from the Pi side.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(4));
    let reads = 0;
    const profileDir = path.dirname(pair.location.vaultFile);
    const vanishing = withReadCli(pair, async (location) => {
      reads += 1;
      const side = await pair.adapter.readCli(location);
      if (reads === 1) fs.rmSync(profileDir, { recursive: true, force: true });
      return side;
    });
    const result = await mod.reconcilePair(vanishing, { loadAuthStorage, retryDelayMs: 20 });
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, null);
    assert.equal(fs.existsSync(profileDir), false, "the deleted directory must stay deleted");
    pass("a managed half whose directory is gone is not rebuilt by the mirror");
  }

  // Runtime: watchers converge both directions, the mirror's own writes are
  // not re-triggering, and both sides rotating at once settle on the newest.
  {
    const { pair } = await managedPair();
    writePi(pair, pi(1));
    writeClaude(pair, claude(1, { accessToken: "pi-access-1", refreshToken: "pi-refresh-1" }));
    const changes = [];
    const mirror = new mod.CredentialMirror({
      loadAuthStorage,
      pollWhenWatchBlind: null,
      debounceMs: 40,
      retryDelayMs: 20,
    });
    mirror.onChanged((change) => changes.push(change));
    mirror.watch(pair);
    assert.deepEqual(mirror.pairFor(CORA_ID), pair);
    assert.equal(mirror.pairForCliProfile("anthropic", CLI_ID).coraProfileId, CORA_ID);
    assert.equal(mirror.pairForCliProfile("xai", CLI_ID), undefined, "lookups are scoped by provider");
    const initial = await mirror.reconcileNow(CORA_ID);
    assert.equal(initial.verdict, "equal");
    // Fresh fs.watch handles on macOS can miss a write issued right after
    // they were created; give them a moment before the first rotation.
    await sleep(150);

    writeClaude(pair, claude(4));
    // The change event follows the write, so wait for it rather than for the
    // file, which is visible a tick earlier.
    await waitFor(() => changes.length === 1);
    assert.equal(readPi(pair).access, "claude-access-4");
    assert.deepEqual(changes[0], { provider: "anthropic", coraProfileId: CORA_ID, cliProfileId: CLI_ID, wrote: "pi" });
    await sleep(200);
    assert.equal(changes.length, 1, "the mirror's own write must not trigger another write");
    const settled = await mirror.reconcileNow(CORA_ID);
    assert.equal(settled.wrote, null);
    assert.equal((await mirror.reconcileNow(CORA_ID)).wrote, null);

    writePi(pair, pi(6));
    await waitFor(() => changes.length === 2);
    assert.equal((await readClaude(pair)).accessToken, "pi-access-6");
    assert.equal(changes.at(-1).wrote, "cli");
    await sleep(200);
    assert.equal(changes.length, 2);

    // Both rotate concurrently: one reconcile in flight at a time, newest wins.
    writePi(pair, pi(10));
    writeClaude(pair, claude(12));
    await Promise.all([mirror.reconcileNow(CORA_ID), mirror.reconcileNow(CORA_ID)]);
    await waitFor(
      async () =>
        readPi(pair).access === "claude-access-12" &&
        (await readClaude(pair)).accessToken === "claude-access-12",
    );
    await sleep(200);
    assert.equal((await mirror.reconcileNow(CORA_ID)).verdict, "equal");

    // The pair follows its profile into the live slot: once the marker names
    // it, a rotation Claude Code writes to the home reaches Cora.
    makeLive(pair);
    writeClaude(pair, claude(20));
    assert.equal((await mirror.reconcileNow(CORA_ID)).wrote, "pi");
    assert.equal(readPi(pair).access, "claude-access-20");

    mirror.rearm();
    // Fresh fs.watch handles on macOS can miss a write issued in the same
    // tick they were created; give them a moment before the next rotation.
    await sleep(150);
    writePi(pair, pi(30));
    await waitFor(async () => (await readClaude(pair)).accessToken === "pi-access-30");
    await mirror.unwatch(CORA_ID);
    assert.equal(await mirror.reconcileNow(CORA_ID), null);
    writePi(pair, pi(40));
    await sleep(150);
    assert.equal((await readClaude(pair)).accessToken, "pi-access-30", "an unwatched pair is left alone");
    mirror.stop();
    pass("watchers converge both ways with self-write suppression and serialized reconciles");
  }

  // Account 1's vault refilled from Cora while another account is live: the
  // vault learns whose login it now holds. A record left from an earlier
  // login (here, another account's) would otherwise make every later
  // reconcile read the pair as foreign, and a switch name the wrong account.
  {
    const { pair, meta } = makePair({ personal: true });
    fs.writeFileSync(meta.markerFile, JSON.stringify({ version: 1, profileId: CLI_ID }), { mode: 0o600 });
    const vaultFile = pair.location.vaultFile;
    const writeVault = (oauthAccount) =>
      fs.writeFileSync(vaultFile, JSON.stringify({ version: 1, store: {}, oauthAccount }), { mode: 0o600 });
    const probe = mod.claudeAdapter.createClaudeAccountAdapter({ store: meta.store, fileOnly: true, platform: "linux" });
    writeVault({ accountUuid: "own-uuid" });
    const ownFingerprint = await probe.cliIdentityFingerprint(pair.location);
    assert.ok(ownFingerprint);
    const stale = { accountUuid: "other-uuid", emailAddress: "other@example.com", displayName: "Other" };
    const withLookup = (answer) => {
      const adapter = mod.claudeAdapter.createClaudeAccountAdapter({
        store: meta.store,
        fileOnly: true,
        platform: "linux",
        readIdentity: async () => answer,
      });
      return { ...pair, adapter, location: adapter.locate("personal"), identityFingerprint: ownFingerprint };
    };

    writeVault(stale);
    writePi(pair, pi(5));
    const online = withLookup({ accountUuid: "own-uuid", fingerprint: ownFingerprint, email: "own@example.com" });
    const filled = await reconcile(online);
    assert.equal(filled.wrote, "cli");
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    assert.equal(vault.store.claudeAiOauth.accessToken, "pi-access-5");
    assert.deepEqual(vault.oauthAccount, { accountUuid: "own-uuid", emailAddress: "own@example.com" });
    writePi(pair, pi(6));
    const next = await reconcile(online);
    assert.notEqual(next.verdict, "foreign", "the pair keeps mirroring");
    assert.equal(next.wrote, "cli");

    // Offline: a record that disagrees with the row is dropped, not kept.
    writeVault(stale);
    writePi(pair, pi(7));
    const offline = withLookup({});
    assert.equal((await reconcile(offline)).wrote, "cli");
    const forgotten = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    assert.equal(forgotten.oauthAccount, undefined);
    assert.equal(forgotten.store.claudeAiOauth.accessToken, "pi-access-7");
    pass("a vault refilled from Cora records the account it now holds, never a stale one");
  }

  // Every file the mirror produced is owner-only.
  {
    const offending = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/auth\.json$|\.credentials\.json$|login\.json$/.test(entry.name) && (mode(file) & 0o077) !== 0) {
          offending.push(file);
        }
      }
    };
    visit(TMP);
    assert.deepEqual(offending, []);
    pass("every produced credential file is 0600");
  }

  console.log(`\nPASS credential mirror over the Claude adapter (${passes} groups)`);
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
