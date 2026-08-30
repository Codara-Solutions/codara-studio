#!/usr/bin/env node
"use strict";

// The provider-generic credential mirror over the Claude adapter, driven
// against real temp directories and the REAL pinned Pi AuthStorage
// (proper-lockfile and all). The Keychain is replaced by an in-memory map so
// no real item is touched.
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
      contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); }`,
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

  // A Keychain that lives in a map, keyed by service, plus the real file half.
  const keychain = new Map();
  const credentialsMod = await (async () => {
    const out = path.join(TMP, "credentials.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "orchestration", "claude-cli-credentials.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: out,
      logLevel: "silent",
    });
    return require(out);
  })();
  const backend = {
    async read(configDir, configDirEnv) {
      return (
        keychain.get(credentialsMod.claudeCliKeychainService(configDirEnv)) ??
        credentialsMod.readCredentialFile(credentialsMod.claudeCredentialFile(configDir))
      );
    },
    async write(configDir, configDirEnv, credential) {
      await credentialsMod.atomicWriteCredential(
        credentialsMod.claudeCredentialFile(configDir),
        credential,
      );
      keychain.set(credentialsMod.claudeCliKeychainService(configDirEnv), credential);
    },
    async clear(configDir, configDirEnv) {
      keychain.delete(credentialsMod.claudeCliKeychainService(configDirEnv));
      fs.rmSync(credentialsMod.claudeCredentialFile(configDir), { force: true });
    },
  };

  // The adapter carries the Keychain seam; a pair built on another backend
  // (a racing or gated one below) gets its own adapter.
  const makeAdapter = (adapterBackend) =>
    mod.claudeAdapter.createClaudeAccountAdapter({ backend: adapterBackend, platform: "linux" });
  const adapter = makeAdapter(backend);
  let pairIndex = 0;
  function makePair(options = {}) {
    pairIndex += 1;
    const root = path.join(TMP, `pair-${pairIndex}`);
    const piDir = path.join(root, "pi", CORA_ID);
    const cliId = options.personal ? "personal" : CLI_ID;
    const configDir = path.join(root, options.personal ? ".claude" : path.join("claude-cli", "accounts", CLI_ID));
    fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return {
      provider: "anthropic",
      coraProfileId: CORA_ID,
      cliProfileId: cliId,
      authFile: path.join(piDir, "auth.json"),
      location: { configDir, configDirEnv: options.personal ? null : configDir },
      adapter,
    };
  }
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
  const writeClaude = (pair, record) => {
    const { configDir, configDirEnv } = pair.location;
    if (record === null) {
      keychain.delete(credentialsMod.claudeCliKeychainService(configDirEnv));
      fs.rmSync(credentialsMod.claudeCredentialFile(configDir), { force: true });
      return;
    }
    const file = credentialsMod.claudeCredentialFile(configDir);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: record }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    keychain.delete(credentialsMod.claudeCliKeychainService(configDirEnv));
  };
  const readClaude = (pair) =>
    adapter.readCli(pair.location).then((side) => (side.kind === "credential" ? side.raw : side));
  const reconcile = (pair, extra = {}) =>
    mod.reconcilePair(pair, { loadAuthStorage, retryDelayMs: 20, ...extra });

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
    const pair = makePair();
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
    assert.equal(mode(credentialsMod.claudeCredentialFile(pair.location.configDir)), 0o600);
    assert.ok(keychain.has(credentialsMod.claudeCliKeychainService(pair.location.configDirEnv)));
    const again = await reconcile(pair);
    assert.equal(again.verdict, "equal");
    assert.equal(again.wrote, null);
    pass("a fresher Pi token flows to Claude Code and the pair is then in sync");
  }

  // Fresher Claude wins: the Pi side is rewritten under Pi's lock with the
  // padding re-applied, and the auth file stays owner-only.
  {
    const pair = makePair();
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
    const pair = makePair();
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
    const pair = makePair();
    writePi(pair, pi(1));
    writeClaude(pair, claude(9, { refreshToken: "" }));
    const result = await reconcile(pair);
    assert.equal(result.verdict, "pi-newer");
    assert.equal((await readClaude(pair)).refreshToken, "pi-refresh-1");
    pass("a refreshable side beats a fresher side with no refresh token");
  }

  // Missing sides are copied for a managed pair, in both directions.
  {
    const pair = makePair();
    writePi(pair, pi(3));
    assert.equal((await reconcile(pair)).wrote, "cli");
    const created = await readClaude(pair);
    assert.equal(created.accessToken, "pi-access-3");
    assert.deepEqual(created.scopes, [...codec.ANTHROPIC_OAUTH_SCOPES]);
    assert.equal("subscriptionType" in created, false);
    const other = makePair();
    writeClaude(other, claude(3));
    assert.equal((await reconcile(other)).wrote, "pi");
    assert.equal(readPi(other).access, "claude-access-3");
    assert.equal(mode(other.authFile), 0o600);
    pass("a missing managed side is created from the other half");
  }

  // Account 1: ~/.claude is never created, and a logout there signs Cora out
  // only when the previous observation had a credential.
  {
    const pair = makePair({ personal: true });
    writePi(pair, pi(3));
    let result = await reconcile(pair);
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, null);
    assert.equal(await readClaude(pair), null, "the mirror never creates ~/.claude's credential");
    assert.deepEqual(readPi(pair), pi(3));
    result = await reconcile(pair, { previousCliPresent: false });
    assert.equal(result.wrote, null);
    result = await reconcile(pair, { previousCliPresent: true });
    assert.equal(result.wrote, "pi-delete");
    assert.equal(readPi(pair), null, "a claude logout signs Account 1 out of Cora");
    assert.equal(mode(pair.authFile), 0o600);
    // The reverse direction never deletes: a missing Pi side with a live
    // ~/.claude simply gets the credential copied to Pi.
    writeClaude(pair, claude(2));
    result = await reconcile(pair, { previousCliPresent: true });
    assert.equal(result.wrote, "pi");
    assert.equal(readPi(pair).access, "claude-access-2");
    // An existing ~/.claude credential IS updated.
    writePi(pair, pi(8));
    assert.equal((await reconcile(pair)).wrote, "cli");
    assert.equal((await readClaude(pair)).accessToken, "pi-access-8");
    pass("Account 1 rules: no creation in ~/.claude, logout propagates one way only");
  }

  // A half-written file is retried, not treated as signed out.
  {
    const pair = makePair();
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
    const pair = makePair();
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

  // The Claude side has no lock: a terminal refresh that lands between the
  // mirror's read and its write must win, or both halves end up holding a
  // refresh token Anthropic already rotated away.
  {
    const pair = makePair();
    writePi(pair, pi(5));
    writeClaude(pair, claude(3));
    let reads = 0;
    const racing = {
      ...backend,
      async read(configDir, configDirEnv) {
        reads += 1;
        if (reads === 2) writeClaude(pair, claude(9));
        return backend.read(configDir, configDirEnv);
      },
    };
    const result = await mod.reconcilePair({ ...pair, adapter: makeAdapter(racing) }, { loadAuthStorage, retryDelayMs: 20 });
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
    const pair = makePair();
    writePi(pair, pi(7));
    writeClaude(pair, claude(2));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let gated = false;
    const slow = {
      ...backend,
      async read(configDir, configDirEnv) {
        if (!gated) {
          gated = true;
          await gate;
        }
        return backend.read(configDir, configDirEnv);
      },
    };
    const mirror = new mod.CredentialMirror({
      loadAuthStorage,
      pollWhenWatchBlind: null,
      debounceMs: 40,
      retryDelayMs: 20,
    });
    mirror.watch({ ...pair, adapter: makeAdapter(slow) });
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

  // A managed directory that vanished between the read and the write (an
  // account mid-delete) is never re-created from the Pi side.
  {
    const pair = makePair();
    writePi(pair, pi(4));
    let reads = 0;
    const vanishing = {
      ...backend,
      async read(configDir, configDirEnv) {
        reads += 1;
        const raw = await backend.read(configDir, configDirEnv);
        if (reads === 1) fs.rmSync(pair.location.configDir, { recursive: true, force: true });
        return raw;
      },
    };
    const result = await mod.reconcilePair({ ...pair, adapter: makeAdapter(vanishing) }, { loadAuthStorage, retryDelayMs: 20 });
    assert.equal(result.verdict, "pi-only");
    assert.equal(result.wrote, null);
    assert.equal(fs.existsSync(pair.location.configDir), false, "the deleted directory must stay deleted");
    assert.equal(keychain.has(credentialsMod.claudeCliKeychainService(pair.location.configDirEnv)), false);
    pass("a managed half whose directory is gone is not rebuilt by the mirror");
  }

  // Runtime: watchers converge both directions, the mirror's own writes are
  // not re-triggering, and both sides rotating at once settle on the newest.
  {
    const pair = makePair();
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

    // A Keychain-only rotation (no file event) is caught by reconcileNow.
    keychain.set(
      credentialsMod.claudeCliKeychainService(pair.location.configDirEnv),
      JSON.stringify({ claudeAiOauth: claude(20) }),
    );
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

  // Every file the mirror produced is owner-only.
  {
    const offending = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/auth\.json$|\.credentials\.json$/.test(entry.name) && (mode(file) & 0o077) !== 0) {
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
