#!/usr/bin/env node
"use strict";

// The Claude account registry (claude-cli-account-profiles.ts): private
// metadata, path safety, defaults, staged deletion recovery, token-blind
// status from each profile's live or vaulted login, and one Claude home for
// every profile. The Keychain is off so no real item is ever read.

process.env.CODARA_DISABLE_KEYCHAIN = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-cli-profiles-"));
const OUT = path.join(TMP, "claude-cli-account-profiles.cjs");

buildSync({
  entryPoints: [
    path.join(
      ROOT,
      "src",
      "main",
      "orchestration",
      "claude-cli-account-profiles.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
});

const mod = require(OUT);
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function writePrivateJson(file, value) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

async function main() {
  const storeRoot = path.join(TMP, "store");
  const personalConfigDir = path.join(TMP, "personal-config");
  privateDir(personalConfigDir);
  fs.writeFileSync(
    path.join(personalConfigDir, "legacy-global-state"),
    "PRESERVE_IN_PLACE",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(personalConfigDir, "settings.json"),
    JSON.stringify({ theme: "dark" }),
    { mode: 0o600 },
  );
  const connectedProfiles = new Set(["personal"]);
  const seenChecks = [];
  let idIndex = 0;
  let tick = 0;
  const store = new mod.ClaudeCliAccountProfileStore(storeRoot, {
    personalConfigDir,
    personalConfigDirEnv: null,
    idFactory: () => IDS[idIndex++],
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)),
    authChecker: async (input) => {
      seenChecks.push({ ...input });
      return connectedProfiles.has(input.profileId)
        ? { connected: true }
        : { connected: false, reason: "missing" };
    },
  });

  // The pre-feature Claude login is represented by a synthetic, path-free row.
  const initial = await store.inspect();
  assert.deepEqual(initial, {
    profiles: [
      {
        id: "personal",
        label: "Account 1",
        managed: false,
        isDefault: true,
        connected: true,
        expired: false,
        canRefresh: false,
        inUse: false,
      },
    ],
    defaultProfileId: "personal",
    reconciliation: {
      restoredProfileIds: [],
      removedDeletingDirectories: [],
      orphanProfileIds: [],
    },
  });
  assert.equal(JSON.stringify(initial).includes(personalConfigDir), false);
  assert.equal(JSON.stringify(initial).includes(storeRoot), false);

  // Missing old persisted fields stay frozen to personal. The mutable default
  // is only selected by a new-session caller using useDefault.
  assert.equal((await store.resolveProfile()).profileId, "personal");
  assert.equal((await store.resolveProfile({ profileId: null })).profileId, "personal");
  assert.equal((await store.resolveProfile({ profileId: "" })).profileId, "personal");

  const alpha = await store.createProfile({ label: "  Work Claude  " });
  assert.equal(alpha.profile.id, IDS[0]);
  assert.equal(alpha.profile.label, "Work Claude");
  assert.equal(alpha.snapshot.defaultProfileId, "personal");
  const alphaDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    alpha.profile.id,
  );
  assert.equal(path.dirname(alphaDir), path.join(storeRoot, "accounts"));
  if (process.platform !== "win32") {
    assert.equal(mode(storeRoot), 0o700);
    assert.equal(mode(path.join(storeRoot, "accounts")), 0o700);
    assert.equal(mode(alphaDir), 0o700);
    assert.equal(mode(path.join(storeRoot, "account-profiles.json")), 0o600);
  }
  // A managed profile is a login, not a Claude home: its directory only ever
  // holds a vault, so nothing is seeded, linked or copied into it.
  assert.deepEqual(
    fs.readdirSync(alphaDir),
    [],
    "a new managed profile starts as an empty vault slot",
  );

  // Every profile runs in the one Claude home.
  const alphaResolved = await store.resolveProfile({ profileId: alpha.profile.id });
  assert.equal(alphaResolved.managed, true);
  assert.equal(alphaResolved.label, "Work Claude");
  assert.equal(alphaResolved.configDir, personalConfigDir);
  assert.equal(alphaResolved.configDirEnv, null);
  assert.deepEqual(fs.readdirSync(alphaDir), [], "resolving never plants anything");

  const metadataText = fs.readFileSync(
    path.join(storeRoot, "account-profiles.json"),
    "utf8",
  );
  assert.equal(metadataText.includes(storeRoot), false);
  assert.equal(metadataText.includes(personalConfigDir), false);
  assert.deepEqual(
    Object.keys(JSON.parse(metadataText).profiles[0]).sort(),
    ["createdAt", "id", "label", "updatedAt"],
  );

  connectedProfiles.add(alpha.profile.id);
  let inspection = await store.inspect();
  assert.equal(
    inspection.profiles.find((row) => row.id === alpha.profile.id).connected,
    true,
  );
  assert.ok(
    seenChecks.some(
      (input) =>
        input.profileId === alpha.profile.id &&
        input.managed === true &&
        input.rootDir === storeRoot &&
        input.configDir === personalConfigDir &&
        input.configDirEnv === null,
    ),
    "the checker learns the profile, the account root and the one home",
  );
  assert.equal(JSON.stringify(inspection).includes(alphaDir), false);

  await store.setDefaultProfile(alpha.profile.id);
  assert.equal(
    (await store.resolveProfile({ useDefault: true })).profileId,
    alpha.profile.id,
  );
  assert.equal((await store.resolveProfile()).profileId, "personal");
  await rejects(() => store.deleteProfile(alpha.profile.id), /current default/i);
  await store.setDefaultProfile("personal");
  connectedProfiles.delete(alpha.profile.id);
  await rejects(
    () => store.setDefaultProfile(alpha.profile.id),
    /connected before it can be default/i,
  );

  const renamed = await store.renameProfile(alpha.profile.id, "Office");
  assert.equal(renamed.label, "Office");
  assert.ok(renamed.updatedAt >= renamed.createdAt);
  for (const invalid of [
    "",
    " ".repeat(4),
    "bad\u0000label",
    "x".repeat(mod.CLAUDE_CLI_PROFILE_LABEL_MAX_LENGTH + 1),
  ]) {
    await rejects(() => store.createProfile({ label: invalid }), /label/i);
  }
  assert.throws(
    () => mod.claudeCliManagedProfileConfigDir(storeRoot, "../escape"),
    /UUIDv4/i,
  );
  assert.throws(
    () => mod.normalizeClaudeCliProfileId("../../escape"),
    /UUIDv4/i,
  );

  // Crash before metadata commit: a registered staged directory is restored.
  const alphaStage = path.join(
    storeRoot,
    "accounts",
    `.${alpha.profile.id}.deleting-deadbeef`,
  );
  fs.writeFileSync(path.join(alphaDir, "opaque-login-state"), "DO_NOT_READ", {
    mode: 0o600,
  });
  fs.renameSync(alphaDir, alphaStage);
  const restored = await store.reconcile();
  assert.deepEqual(restored.restoredProfileIds, [alpha.profile.id]);
  assert.equal(fs.existsSync(path.join(alphaDir, "opaque-login-state")), true);

  // Crash after metadata commit: an unregistered staged directory is removed.
  const beta = await store.createProfile({ label: "Disposable" });
  const betaDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    beta.profile.id,
  );
  const disk = JSON.parse(
    fs.readFileSync(path.join(storeRoot, "account-profiles.json"), "utf8"),
  );
  disk.profiles = disk.profiles.filter(
    (profile) => profile.id !== beta.profile.id,
  );
  fs.writeFileSync(
    path.join(storeRoot, "account-profiles.json"),
    `${JSON.stringify(disk, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(storeRoot, "account-profiles.json"), 0o600);
  }
  const betaStageName = `.${beta.profile.id}.deleting-cafebabe`;
  const betaStage = path.join(storeRoot, "accounts", betaStageName);
  fs.renameSync(betaDir, betaStage);
  const removed = await store.reconcile();
  assert.ok(removed.removedDeletingDirectories.includes(betaStageName));
  assert.equal(fs.existsSync(betaStage), false);

  // Unknown UUID directories may be the only copy of a login, so preserve and
  // report them instead of guessing that deletion is safe.
  const orphan = path.join(storeRoot, "accounts", IDS[5]);
  privateDir(orphan);
  fs.writeFileSync(path.join(orphan, "opaque-login-state"), "ORPHAN", {
    mode: 0o600,
  });
  const orphanResult = await store.reconcile();
  assert.ok(orphanResult.orphanProfileIds.includes(IDS[5]));
  assert.equal(fs.existsSync(path.join(orphan, "opaque-login-state")), true);

  const gamma = await store.createProfile({ label: "Delete me" });
  const gammaDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    gamma.profile.id,
  );
  const deleted = await store.deleteProfile(gamma.profile.id);
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(gammaDir), false);
  assert.equal(fs.existsSync(alphaDir), true);
  assert.equal((await store.deleteProfile(gamma.profile.id)).deleted, false);
  await rejects(() => store.deleteProfile("personal"), /cannot be deleted/i);
  // A running terminal never pins a profile: sessions run on the live login
  // in the one home, not inside a profile's directory.
  const leased = new mod.ClaudeCliAccountProfileStore(storeRoot, {
    personalConfigDir,
    personalConfigDirEnv: null,
    idFactory: () => IDS[4],
    authChecker: () => ({ connected: false }),
    leases: { isLeased: () => true },
  });
  const pinned = await leased.createProfile({ label: "Leased" });
  assert.equal((await leased.deleteProfile(pinned.profile.id)).deleted, true);

  // Profile, store-root, accounts, and metadata symlinks are never followed.
  const symlinkProfile = await store.createProfile({ label: "Symlink target" });
  const symlinkDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    symlinkProfile.profile.id,
  );
  fs.rmSync(symlinkDir, { recursive: true, force: true });
  fs.symlinkSync(personalConfigDir, symlinkDir, "dir");
  const symlinkResolved = await store.resolveProfile({ profileId: symlinkProfile.profile.id });
  assert.equal(symlinkResolved.configDir, personalConfigDir, "a planted link never becomes a home");
  await rejects(
    () => store.deleteProfile(symlinkProfile.profile.id),
    /unsafe|symlink/i,
  );
  assert.equal(
    fs.readFileSync(path.join(personalConfigDir, "legacy-global-state"), "utf8"),
    "PRESERVE_IN_PLACE",
    "a refused delete never reaches through the link",
  );

  const linkedRootTarget = path.join(TMP, "linked-root-target");
  privateDir(linkedRootTarget);
  const linkedRoot = path.join(TMP, "linked-root");
  fs.symlinkSync(linkedRootTarget, linkedRoot, "dir");
  const rootAttack = new mod.ClaudeCliAccountProfileStore(linkedRoot, {
    personalConfigDir,
    authChecker: () => ({ connected: false }),
  });
  await rejects(() => rootAttack.createProfile({ label: "Nope" }), /unsafe|symlink/i);

  const accountsAttackRoot = path.join(TMP, "accounts-attack");
  privateDir(accountsAttackRoot);
  fs.symlinkSync(personalConfigDir, path.join(accountsAttackRoot, "accounts"), "dir");
  const accountsAttack = new mod.ClaudeCliAccountProfileStore(
    accountsAttackRoot,
    { personalConfigDir, authChecker: () => ({ connected: false }) },
  );
  await rejects(
    () => accountsAttack.createProfile({ label: "Nope" }),
    /unsafe|symlink/i,
  );

  const metadataAttackRoot = path.join(TMP, "metadata-attack");
  privateDir(metadataAttackRoot);
  const outsideMetadata = path.join(TMP, "outside-metadata.json");
  fs.writeFileSync(
    outsideMetadata,
    '{"version":1,"profiles":[],"defaultProfileId":"personal"}',
    { mode: 0o600 },
  );
  fs.symlinkSync(
    outsideMetadata,
    path.join(metadataAttackRoot, "account-profiles.json"),
  );
  const metadataAttack = new mod.ClaudeCliAccountProfileStore(
    metadataAttackRoot,
    { personalConfigDir, authChecker: () => ({ connected: false }) },
  );
  await rejects(() => metadataAttack.snapshot(), /unsafe|symlink/i);

  // Strict schema and private file modes turn corruption into an explicit
  // error; they never silently reinterpret unknown data as a credential.
  const corruptRoot = path.join(TMP, "corrupt");
  privateDir(corruptRoot);
  fs.writeFileSync(
    path.join(corruptRoot, "account-profiles.json"),
    '{"version":1,"profiles":[],"defaultProfileId":"personal","token":"NO"}',
    { mode: 0o600 },
  );
  const corrupt = new mod.ClaudeCliAccountProfileStore(corruptRoot, {
    personalConfigDir,
    authChecker: () => ({ connected: false }),
  });
  await rejects(() => corrupt.snapshot(), /unexpected field/i);
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(corruptRoot, "account-profiles.json"), 0o644);
    await rejects(() => corrupt.snapshot(), /group or other users/i);
  }

  // The live-home fallback uses Claude's supported CLI command. Only
  // loggedIn survives parsing, and the provider-override routes are stripped.
  const authDir = path.join(TMP, "auth-probe");
  privateDir(authDir);
  const captureFile = path.join(TMP, "auth-probe-capture.json");
  const fakeClaude = path.join(TMP, "fake-claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  configDir: process.env.CLAUDE_CONFIG_DIR,
  hasApiKey: Object.keys(process.env).some((key) => key.toUpperCase() === "ANTHROPIC_API_KEY"),
  hasOauth: Object.keys(process.env).some((key) => key.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN"),
  hasAws: Object.keys(process.env).some((key) => key.toUpperCase() === "AWS_ACCESS_KEY_ID")
}));
process.stdout.write(JSON.stringify({ loggedIn: true, token: "MUST_BE_DISCARDED", email: "discard@example.test" }));
`,
    { mode: 0o700 },
  );
  fs.chmodSync(fakeClaude, 0o700);
  const authStatus = await mod.defaultClaudeCliAuthChecker(
    {
      profileId: "personal",
      managed: false,
      rootDir: storeRoot,
      configDir: authDir,
      configDirEnv: authDir,
    },
    {
      claudeExecutable: fakeClaude,
      baseEnv: {
        PATH: process.env.PATH,
        CAPTURE_FILE: captureFile,
        ANTHROPIC_API_KEY: "SECRET",
        claude_code_oauth_token: "SECRET",
        Aws_Access_Key_Id: "SECRET",
      },
    },
  );
  assert.deepEqual(authStatus, { connected: true });
  assert.equal(JSON.stringify(authStatus).includes("MUST_BE_DISCARDED"), false);
  const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
  assert.deepEqual(capture.argv, ["auth", "status", "--json"]);
  assert.equal(capture.configDir, authDir);
  assert.equal(capture.hasApiKey, false);
  assert.equal(capture.hasOauth, false);
  assert.equal(
    capture.hasAws,
    true,
    "generic cloud credentials must remain available to project shell commands",
  );

  // Normal existing ~/.claude directories are commonly 0755; the home is the
  // user's own, so it is accepted without being changed.
  if (process.platform !== "win32") {
    const ordinaryPersonal = path.join(TMP, "ordinary-personal");
    privateDir(ordinaryPersonal);
    fs.chmodSync(ordinaryPersonal, 0o755);
    assert.deepEqual(
      await mod.defaultClaudeCliAuthChecker(
        {
          profileId: "personal",
          managed: false,
          rootDir: storeRoot,
          configDir: ordinaryPersonal,
          configDirEnv: null,
        },
        {
          claudeExecutable: fakeClaude,
          baseEnv: {
            PATH: process.env.PATH,
            CAPTURE_FILE: captureFile,
          },
        },
      ),
      { connected: true },
    );
    assert.equal(mode(ordinaryPersonal), 0o755);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(fs.readFileSync(captureFile, "utf8")),
        "configDir",
      ),
      false,
      "the live home's auth status must preserve an originally-unset CLAUDE_CONFIG_DIR",
    );
  }

  // Studio can be launched from a terminal that an older Studio pointed at a
  // managed account directory. That is never the user's own Claude home.
  {
    const codaraHome = path.join(TMP, "env-loop", "Codara");
    const managed = path.join(codaraHome, "claude-cli", "accounts", IDS[0]);
    const pointerDir = path.join(codaraHome, "cli", "active");
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(pointerDir, { recursive: true });
    const pointer = path.join(pointerDir, "claude");
    fs.symlinkSync(managed, pointer, "dir");
    const ownDir = path.join(TMP, "env-loop", "my-own-claude");
    fs.mkdirSync(ownDir, { recursive: true });
    const personalDefault = path.resolve(path.join(os.homedir(), ".claude"));
    const previousHome = process.env.CODARA_HOME_DIR;
    const previousSelector = process.env.CLAUDE_CONFIG_DIR;
    process.env.CODARA_HOME_DIR = codaraHome;
    try {
      for (const selector of [managed, pointer]) {
        process.env.CLAUDE_CONFIG_DIR = selector;
        assert.equal(mod.defaultPersonalClaudeConfigDirEnv(), null);
        assert.equal(mod.defaultPersonalClaudeConfigDir(), personalDefault);
        const envStore = new mod.ClaudeCliAccountProfileStore(
          path.join(TMP, "env-loop", "store"),
        );
        assert.equal(envStore.personalConfigDirEnv, null);
        assert.equal(envStore.personalConfigDir, personalDefault);
      }
      // A directory of the user's own is the one home.
      process.env.CLAUDE_CONFIG_DIR = ownDir;
      assert.equal(mod.defaultPersonalClaudeConfigDirEnv(), ownDir);
      assert.equal(mod.defaultPersonalClaudeConfigDir(), ownDir);
      assert.equal(
        new mod.ClaudeCliAccountProfileStore(path.join(TMP, "env-loop", "store"))
          .personalConfigDir,
        ownDir,
      );
    } finally {
      if (previousHome === undefined) delete process.env.CODARA_HOME_DIR;
      else process.env.CODARA_HOME_DIR = previousHome;
      if (previousSelector === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousSelector;
    }
  }

  // The production checker is a token-blind read of the profile's login:
  // the live slot while the profile is live, its vault otherwise. A refresh
  // token means connected, the raw expiry rides along so a lapsed access
  // token reads as "refreshing" rather than "signed out", and a vaulted
  // profile never spawns `claude`.
  {
    const root = path.join(TMP, "credential-checker", "root");
    const home = path.join(TMP, "credential-checker", "home", ".claude");
    privateDir(root);
    privateDir(home);
    const probe = (profileId) => ({
      profileId,
      managed: profileId !== "personal",
      rootDir: root,
      configDir: home,
      configDirEnv: null,
    });
    let fallbackCalls = 0;
    const options = {
      liveFallback: () => {
        fallbackCalls += 1;
        return { connected: true };
      },
    };
    const vaultOf = (id) => path.join(root, "accounts", id, "login.json");
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe(IDS[1]), options),
      { connected: false, reason: "missing" },
    );
    writePrivateJson(vaultOf(IDS[1]), {
      version: 1,
      store: {
        claudeAiOauth: {
          accessToken: "MUST_NOT_LEAK",
          refreshToken: "MUST_NOT_LEAK_REFRESH",
          expiresAt: 1_800_000_000_000,
          scopes: ["user:inference"],
        },
      },
    });
    const connected = await mod.claudeCredentialAuthChecker(probe(IDS[1]), options);
    assert.deepEqual(connected, {
      connected: true,
      expiresAt: 1_800_000_000_000,
      canRefresh: true,
    });
    assert.equal(JSON.stringify(connected).includes("MUST_NOT_LEAK"), false);
    writePrivateJson(vaultOf(IDS[1]), {
      version: 1,
      store: { claudeAiOauth: { accessToken: "only-access", expiresAt: 1 } },
    });
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe(IDS[1]), options),
      { connected: true, expiresAt: 1, canRefresh: false },
    );
    fs.writeFileSync(vaultOf(IDS[1]), "not json at all", { mode: 0o600 });
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe(IDS[1]), options),
      { connected: false, reason: "unavailable" },
    );
    assert.equal(fallbackCalls, 0, "a vaulted profile never consults the fallback");

    // The live profile (personal before any marker) reads the home's store,
    // and an empty one asks the fallback once and caches the verdict.
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe("personal"), options),
      { connected: true },
    );
    await mod.claudeCredentialAuthChecker(probe("personal"), options);
    assert.equal(fallbackCalls, 1);
    writePrivateJson(path.join(home, ".credentials.json"), {
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 5 },
      mcpOAuth: { server: { accessToken: "grant" } },
    });
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe("personal"), { liveFallback: null }),
      { connected: true, expiresAt: 5, canRefresh: true },
    );
    // Once the marker names another profile, personal reads its vault.
    writePrivateJson(path.join(root, "live-login.json"), { version: 1, profileId: IDS[1] });
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe("personal"), { liveFallback: null }),
      { connected: false, reason: "missing" },
    );
    assert.deepEqual(
      await mod.claudeCredentialAuthChecker(probe(IDS[1]), { liveFallback: null }),
      { connected: true, expiresAt: 5, canRefresh: true },
      "the live profile reads the home's store",
    );

    // A store built on the credential checker reports expiry per card.
    const expiryRoot = path.join(TMP, "credential-checker", "store");
    const expiryHome = path.join(TMP, "credential-checker", "expiry-home", ".claude");
    privateDir(expiryHome);
    const expiryStore = new mod.ClaudeCliAccountProfileStore(expiryRoot, {
      personalConfigDir: expiryHome,
      personalConfigDirEnv: null,
      idFactory: () => IDS[2],
      now: () => new Date(2_000_000_000_000),
      authChecker: (input) => mod.claudeCredentialAuthChecker(input, { liveFallback: null }),
    });
    const lapsed = await expiryStore.createProfile({ label: "Lapsed" });
    writePrivateJson(path.join(expiryStore.rootDir, "accounts", lapsed.profile.id, "login.json"), {
      version: 1,
      store: {
        claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1_999_999_999_000 },
      },
    });
    const lapsedRow = (await expiryStore.inspect()).profiles.find((row) => row.id === lapsed.profile.id);
    assert.equal(lapsedRow.connected, true);
    assert.equal(lapsedRow.expired, true);
    assert.equal(lapsedRow.canRefresh, true);
  }

  // Codara records the account behind a Claude config directory the way
  // Claude Code does after its own login (the retired selector's undo uses it).
  {
    const identityDir = path.join(TMP, "identity", IDS[3]);
    privateDir(identityDir);
    fs.writeFileSync(
      path.join(identityDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }),
      { mode: 0o600 },
    );
    await mod.writeManagedClaudeIdentity(identityDir, {
      accountUuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      emailAddress: "someone@example.com",
      organizationUuid: "org-1",
    });
    const written = JSON.parse(fs.readFileSync(path.join(identityDir, ".claude.json"), "utf8"));
    assert.deepEqual(written, {
      hasCompletedOnboarding: true,
      numStartups: 3,
      oauthAccount: {
        accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        emailAddress: "someone@example.com",
        organizationUuid: "org-1",
      },
    });
    if (process.platform !== "win32") {
      assert.equal(mode(path.join(identityDir, ".claude.json")), 0o600);
    }
    await mod.writeManagedClaudeIdentity(identityDir, { accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(identityDir, ".claude.json"), "utf8")).oauthAccount.emailAddress,
      "someone@example.com",
      "a rewrite without an address keeps the one already recorded",
    );
    const freshDir = path.join(TMP, "identity", IDS[4]);
    privateDir(freshDir);
    await mod.writeManagedClaudeIdentity(freshDir, { accountUuid: "x" });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(freshDir, ".claude.json"), "utf8")),
      { oauthAccount: { accountUuid: "x" } },
    );
    await rejects(() => mod.writeManagedClaudeIdentity(freshDir, { accountUuid: " " }), /account uuid/i);
  }

  const source = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "main",
      "orchestration",
      "claude-cli-account-profiles.ts",
    ),
    "utf8",
  );
  const checkerSource = source.slice(
    source.indexOf("export async function defaultClaudeCliAuthChecker"),
    source.indexOf("export class ClaudeCliAccountProfileStore"),
  );
  assert.equal(/\breadFile\b/.test(checkerSource), false);
  assert.equal(/auth\\.json|\bfs\./i.test(checkerSource), false);
  assert.equal(
    source.includes("ensureSharedCliState"),
    false,
    "no Claude profile is ever a directory of links",
  );

  console.log(
    "PASS native Claude account store: private metadata, token-blind status from the live or vaulted login, one home for every profile, path safety, defaults, staged deletion recovery, managed identity, and leak-free projection",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
