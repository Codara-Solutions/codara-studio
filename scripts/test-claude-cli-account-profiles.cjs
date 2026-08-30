#!/usr/bin/env node
"use strict";

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

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

/**
 * Every one of these appears in the adversarial personal fixture below. None
 * may ever reach a managed account directory: a managed account is a separate
 * login, so a copied credential would cross accounts and a copied identifier
 * would carry the personal machine's identity into one.
 */
const FORBIDDEN_SEED_MARKERS = [
  "oauthAccount",
  "MUST_NOT_CROSS",
  "userID",
  "anonymousId",
  "machineID",
  "projects",
  "mcpServers",
  "customApiKeyResponses",
  "apiKeyHelper",
  "hooks",
  "env",
  "hasAvailableSubscription",
];

/** Shaped like a real ~/.claude.json, with every identity-bearing key present. */
function adversarialPersonalConfig() {
  return {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.220",
    oauthAccount: {
      accountUuid: "MUST_NOT_CROSS",
      emailAddress: "MUST_NOT_CROSS@example.test",
      organizationUuid: "MUST_NOT_CROSS",
    },
    userID: "MUST_NOT_CROSS",
    anonymousId: "MUST_NOT_CROSS",
    machineID: "MUST_NOT_CROSS",
    hasAvailableSubscription: true,
    customApiKeyResponses: { approved: ["MUST_NOT_CROSS"] },
    projects: { "/Users/someone/repo": { hasTrustDialogAccepted: true } },
    mcpServers: { secretary: { command: "MUST_NOT_CROSS" } },
    numStartups: 229,
  };
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
  // Claude Code 2.1.220 prefers <configDir>/.config.json over the
  // $CLAUDE_CONFIG_DIR-or-home .claude.json, so this is the read the store
  // makes for a personal profile whose selector is unset.
  fs.writeFileSync(
    path.join(personalConfigDir, ".config.json"),
    JSON.stringify(adversarialPersonalConfig()),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(personalConfigDir, "settings.json"),
    JSON.stringify({
      theme: "dark",
      apiKeyHelper: "MUST_NOT_CROSS",
      env: { ANTHROPIC_API_KEY: "MUST_NOT_CROSS" },
      hooks: { PreToolUse: [{ command: "MUST_NOT_CROSS" }] },
      model: "MUST_NOT_CROSS",
    }),
    { mode: 0o600 },
  );
  const connectedDirs = new Set([personalConfigDir]);
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
      return connectedDirs.has(input.configDir)
        ? { connected: true }
        : { connected: false, reason: "missing" };
    },
  });

  // The pre-feature Claude home is represented by a synthetic, path-free row.
  const initial = await store.inspect();
  assert.deepEqual(initial, {
    profiles: [
      {
        id: "personal",
        label: "Account 1",
        managed: false,
        isDefault: true,
        connected: true,
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
  assert.equal(
    fs.existsSync(path.join(alphaDir, "legacy-global-state")),
    false,
    "managed profiles must not copy personal/global Claude state",
  );

  // A fresh managed directory is seeded past Claude Code's first-run wizard
  // (hasCompletedOnboarding in .claude.json) and shares the user-state
  // surfaces with the personal config directory through symlinks
  // (native-cli-shared-state.ts). The theme is no longer copied: the managed
  // settings.json IS the personal settings.json, reached through a link.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(alphaDir, ".claude.json"), "utf8")),
    { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.220" },
  );
  assert.equal(
    fs.lstatSync(path.join(alphaDir, "settings.json")).isSymbolicLink(),
    true,
    "settings.json must be shared with the personal home via a link",
  );
  assert.equal(
    fs.readlinkSync(path.join(alphaDir, "settings.json")),
    path.join(personalConfigDir, "settings.json"),
  );
  assert.equal(
    fs.lstatSync(path.join(alphaDir, "projects")).isSymbolicLink(),
    true,
    "chats must be shared with the personal home via a link",
  );
  if (process.platform !== "win32") {
    assert.equal(mode(path.join(alphaDir, ".claude.json")), 0o600);
  }
  {
    // Only .claude.json is a COPY, and a copy must never carry identity or
    // credentials. settings.json is deliberately not held to this: it is a
    // link to the user's own personal settings file, not a copied file, so
    // its content stays wherever the user put it.
    const seededText = fs.readFileSync(path.join(alphaDir, ".claude.json"), "utf8");
    for (const forbidden of FORBIDDEN_SEED_MARKERS) {
      assert.equal(
        seededText.includes(forbidden),
        false,
        `seeded first-run preferences must never carry ${forbidden}`,
      );
    }
  }

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

  connectedDirs.add(alphaDir);
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
        input.configDir === alphaDir,
    ),
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

  // Crash before metadata commit: a registered staged config is restored.
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

  // Crash after metadata commit: an unregistered staged config is removed.
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

  // Profile, store-root, accounts, and metadata symlinks are never followed.
  const symlinkProfile = await store.createProfile({ label: "Symlink target" });
  const symlinkDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    symlinkProfile.profile.id,
  );
  fs.rmSync(symlinkDir, { recursive: true, force: true });
  fs.symlinkSync(personalConfigDir, symlinkDir, "dir");
  await rejects(
    () => store.resolveProfile({ profileId: symlinkProfile.profile.id }),
    /unsafe|symlink/i,
  );
  await rejects(
    () => store.deleteProfile(symlinkProfile.profile.id),
    /unsafe|symlink/i,
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

  // Production auth status uses Claude's supported CLI command under the
  // selected config directory. Only loggedIn survives parsing.
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
      profileId: IDS[0],
      managed: true,
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

  // Normal existing ~/.claude directories are commonly 0755. Personal is
  // accepted without mutating it, while managed profile directories are held
  // to the private 0700 invariant.
  if (process.platform !== "win32") {
    const ordinaryPersonal = path.join(TMP, "ordinary-personal");
    privateDir(ordinaryPersonal);
    fs.chmodSync(ordinaryPersonal, 0o755);
    assert.deepEqual(
      await mod.defaultClaudeCliAuthChecker(
        {
          profileId: "personal",
          managed: false,
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
      "personal auth status must preserve an originally-unset CLAUDE_CONFIG_DIR",
    );
  }

  if (process.platform !== "win32") {
    fs.chmodSync(authDir, 0o755);
    assert.deepEqual(
      await mod.defaultClaudeCliAuthChecker(
        {
          profileId: IDS[0],
          managed: true,
          configDir: authDir,
          configDirEnv: authDir,
        },
        { claudeExecutable: fakeClaude },
      ),
      { connected: false, reason: "unsafe" },
    );
  }
  assert.deepEqual(
    await mod.defaultClaudeCliAuthChecker(
      {
        profileId: IDS[0],
        managed: true,
        configDir: path.join(TMP, "does-not-exist"),
        configDirEnv: path.join(TMP, "does-not-exist"),
      },
      { claudeExecutable: fakeClaude },
    ),
    { connected: false, reason: "missing" },
  );

  // Studio can be launched from a terminal that already sources the generated
  // env.sh, so CLAUDE_CONFIG_DIR may arrive pointing at the Active managed
  // account. That is never the user's personal login.
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
        const store = new mod.ClaudeCliAccountProfileStore(
          path.join(TMP, "env-loop", "store"),
        );
        assert.equal(store.personalConfigDirEnv, null);
        assert.equal(store.personalConfigDir, personalDefault);
      }
      // A directory of the user's own still selects the personal login.
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

  // First-run seeding is best-effort and strictly allowlisted. Each case below
  // gets its own store so the personal read is fully contained by the fixture.
  {
    let seedIndex = 0;
    const seedStore = (name, options) =>
      new mod.ClaudeCliAccountProfileStore(path.join(TMP, "seed", name), {
        idFactory: () => IDS[seedIndex++],
        authChecker: () => ({ connected: false }),
        ...options,
      });
    // The shared-state links (projects, settings.json, …) are created on
    // every profile, so seeding is judged by the two files the seeder could
    // COPY, never by an exact directory listing.
    const isShareLink = (dir, name, personalDir) => {
      const stat = fs.lstatSync(path.join(dir, name));
      return (
        stat.isSymbolicLink() &&
        fs.readlinkSync(path.join(dir, name)) === path.join(personalDir, name)
      );
    };

    // No personal config at all: create the account, link the share set, and
    // copy nothing.
    const barePersonal = path.join(TMP, "seed-bare-personal");
    privateDir(barePersonal);
    const bare = seedStore("bare", {
      personalConfigDir: barePersonal,
      personalConfigDirEnv: barePersonal,
    });
    const bareProfile = await bare.createProfile({ label: "Bare" });
    const bareDir = mod.claudeCliManagedProfileConfigDir(
      path.join(TMP, "seed", "bare"),
      bareProfile.profile.id,
    );
    assert.equal(
      fs.existsSync(path.join(bareDir, ".claude.json")),
      false,
      "a missing personal config must seed nothing",
    );
    assert.equal(
      fs.existsSync(path.join(bareDir, "settings.json")),
      false,
      "a missing personal settings.json must not produce a dangling link",
    );
    assert.ok(isShareLink(bareDir, "projects", barePersonal));

    // The $CLAUDE_CONFIG_DIR-relative .claude.json is the other supported
    // source, and only the allowlist crosses from it.
    const selectorPersonal = path.join(TMP, "seed-selector-personal");
    privateDir(selectorPersonal);
    fs.writeFileSync(
      path.join(selectorPersonal, ".claude.json"),
      JSON.stringify(adversarialPersonalConfig()),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(selectorPersonal, "settings.json"),
      JSON.stringify({ theme: "light-daltonized" }),
      { mode: 0o600 },
    );
    const selector = seedStore("selector", {
      personalConfigDir: selectorPersonal,
      personalConfigDirEnv: selectorPersonal,
    });
    const selectorProfile = await selector.createProfile({ label: "Selector" });
    const selectorDir = mod.claudeCliManagedProfileConfigDir(
      path.join(TMP, "seed", "selector"),
      selectorProfile.profile.id,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(selectorDir, ".claude.json"), "utf8")),
      { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.220" },
    );
    assert.equal(
      fs.lstatSync(path.join(selectorDir, ".claude.json")).isSymbolicLink(),
      false,
      ".claude.json is per-account and must stay a private copy",
    );
    // The theme is not copied anymore: the settings arrive through the link.
    assert.ok(isShareLink(selectorDir, "settings.json", selectorPersonal));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(selectorDir, "settings.json"), "utf8")),
      { theme: "light-daltonized" },
    );

    // A personal config that is a symlink is never followed, and an unfinished
    // personal onboarding is never claimed as finished.
    const symlinkPersonal = path.join(TMP, "seed-symlink-personal");
    privateDir(symlinkPersonal);
    fs.symlinkSync(
      path.join(selectorPersonal, ".claude.json"),
      path.join(symlinkPersonal, ".claude.json"),
    );
    const symlinked = seedStore("symlinked", {
      personalConfigDir: symlinkPersonal,
      personalConfigDirEnv: symlinkPersonal,
    });
    const symlinkedProfile = await symlinked.createProfile({ label: "Symlinked" });
    assert.equal(
      fs.existsSync(
        path.join(
          mod.claudeCliManagedProfileConfigDir(
            path.join(TMP, "seed", "symlinked"),
            symlinkedProfile.profile.id,
          ),
          ".claude.json",
        ),
      ),
      false,
      "a symlinked personal config must never be read",
    );

    // Unfinished personal onboarding is never claimed as finished, and the
    // personal settings.json is linked as-is — it is the user's own file, so
    // even odd content in it is shared rather than filtered into a copy.
    const partialPersonal = path.join(TMP, "seed-partial-personal");
    privateDir(partialPersonal);
    fs.writeFileSync(
      path.join(partialPersonal, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: false,
        lastOnboardingVersion: "2.1.220",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(partialPersonal, "settings.json"),
      JSON.stringify({ theme: "../../escape" }),
      { mode: 0o600 },
    );
    const partial = seedStore("partial", {
      personalConfigDir: partialPersonal,
      personalConfigDirEnv: partialPersonal,
    });
    const partialProfile = await partial.createProfile({ label: "Partial" });
    const partialDir = mod.claudeCliManagedProfileConfigDir(
      path.join(TMP, "seed", "partial"),
      partialProfile.profile.id,
    );
    assert.equal(fs.existsSync(path.join(partialDir, ".claude.json")), false);
    assert.ok(isShareLink(partialDir, "settings.json", partialPersonal));

    // Pure projection, checked directly so the allowlist cannot be widened by
    // accident: the output keys are exactly the declared ones.
    assert.deepEqual(
      Object.keys(mod.pickClaudeCliFirstRunConfig(adversarialPersonalConfig())).sort(),
      [...mod.CLAUDE_CLI_SEEDED_CONFIG_KEYS].sort(),
    );
    assert.deepEqual(mod.pickClaudeCliFirstRunConfig(null), {});
    assert.deepEqual(
      mod.pickClaudeCliFirstRunConfig({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: "../../../etc/passwd",
      }),
      { hasCompletedOnboarding: true },
    );
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

  console.log(
    "PASS native Claude account store: private metadata, CLI-only token-blind auth, path safety, defaults, staged deletion recovery, allowlisted first-run seeding, and leak-free projection",
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
