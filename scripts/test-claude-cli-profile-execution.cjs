#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-cli-execution-"));
const OUT = path.join(TMP, "claude-cli-profile-execution.cjs");
const STORE_OUT = path.join(TMP, "claude-cli-account-profiles.cjs");
const ENV_OUT = path.join(TMP, "claude-cli-profile-environment.cjs");

for (const [entry, outfile] of [
  ["claude-cli-profile-execution.ts", OUT],
  ["claude-cli-account-profiles.ts", STORE_OUT],
  ["claude-cli-profile-environment.ts", ENV_OUT],
]) {
  buildSync({
    entryPoints: [
      path.join(ROOT, "src", "main", "orchestration", entry),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
  });
}

const mod = { ...require(STORE_OUT), ...require(ENV_OUT), ...require(OUT) };
const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

async function main() {
  const exactConfigDir = path.join(TMP, "exact-config");
  const baseEnv = {
    PATH: "/safe/bin",
    HOME: "/do/not/change",
    SPARK_AGENT_TOKEN: "local-socket-token",
    CLAUDE_CONFIG_DIR: "/wrong/config",
    anthropic_api_key: "lowercase-secret",
    ANTHROPIC_AUTH_TOKEN: "bearer-secret",
    Anthropic_Oauth_Token: "oauth-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong/secure-storage",
    CLAUDE_CODE_HOST_CREDS_FILE: "/wrong/host-creds.json",
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: "HOST_TOKEN",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    USE_LOCAL_OAUTH: "1",
    USE_STAGING_OAUTH: "1",
    CLAUDE_LOCAL_OAUTH_API_BASE: "https://oauth-bypass.example",
    ANTHROPIC_BASE_URL: "https://bypass.example",
    ANTHROPIC_CUSTOM_HEADERS: "authorization: nope",
    ANTHROPIC_AWS_API_KEY: "aws-provider-secret",
    anthropic_aws_base_url: "https://aws-provider.example",
    ANTHROPIC_MANTLE_BASE_URL: "https://mantle.example",
    Anthropic_Bedrock_Mantle_Base_Url: "https://current-mantle.example",
    ANTHROPIC_FOUNDRY_AUTH_TOKEN: "foundry-secret",
    ANTHROPIC_VERTEX_PROJECT_ID: "vertex-provider-project",
    claude_code_oauth_refresh_token: "refresh-secret",
    CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    Claude_Code_Use_Vertex: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CODE_USE_MANTLE: "1",
    Claude_Code_Skip_Anthropic_Aws_Auth: "1",
    AWS_ACCESS_KEY_ID: "aws-secret",
    aws_secret_access_key: "aws-secret",
    AWS_SESSION_TOKEN: "aws-secret",
    AWS_BEARER_TOKEN_BEDROCK: "aws-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json",
    SAFE_VALUE: "keep-me",
    UNDEFINED_VALUE: undefined,
  };
  const original = { ...baseEnv };
  const env = mod.buildClaudeCliProfileEnvironment(baseEnv, exactConfigDir);
  assert.deepEqual(baseEnv, original, "input environment must not be mutated");
  assert.notEqual(env, baseEnv);
  assert.equal(env.CLAUDE_CONFIG_DIR, exactConfigDir);
  assert.equal(env.PATH, "/safe/bin");
  assert.equal(env.HOME, "/do/not/change");
  assert.equal(env.SPARK_AGENT_TOKEN, "local-socket-token");
  assert.equal(env.SAFE_VALUE, "keep-me");
  assert.equal(env.AWS_ACCESS_KEY_ID, "aws-secret");
  assert.equal(env.aws_secret_access_key, "aws-secret");
  assert.equal(env.AWS_SESSION_TOKEN, "aws-secret");
  assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, "/secret/google.json");
  for (const key of Object.keys(env)) {
    assert.equal(
      mod.CLAUDE_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES.has(key.toUpperCase()),
      false,
      `credential or provider bypass survived: ${key}`,
    );
  }
  assert.equal("anthropic_api_key" in env, false);
  assert.equal("UNDEFINED_VALUE" in env, false);
  assert.throws(
    () => mod.buildClaudeCliProfileEnvironment({}, ""),
    /non-empty/i,
  );
  assert.throws(
    () => mod.buildClaudeCliProfileEnvironment({}, "relative/config"),
    /absolute/i,
  );
  assert.throws(
    () =>
      mod.buildClaudeCliProfileEnvironment(
        {},
        `${exactConfigDir}${path.sep}..${path.sep}${path.basename(exactConfigDir)}`,
      ),
    /canonical/i,
  );

  const storeRoot = path.join(TMP, "store");
  const personalConfigDir = path.join(TMP, "personal");
  privateDir(personalConfigDir);
  const connected = new Set([personalConfigDir]);
  const leases = new mod.ClaudeCliProfileLeaseRegistry();
  const ids = [PROFILE_ID, OTHER_ID];
  const store = new mod.ClaudeCliAccountProfileStore(storeRoot, {
    personalConfigDir,
    personalConfigDirEnv: null,
    idFactory: () => ids.shift(),
    leases,
    authChecker: ({ configDir }) =>
      connected.has(configDir)
        ? { connected: true }
        : { connected: false, reason: "missing" },
  });
  const profile = await store.createProfile({ label: "Native account" });
  const profileConfigDir = mod.claudeCliManagedProfileConfigDir(
    storeRoot,
    profile.profile.id,
  );
  connected.add(profileConfigDir);
  await store.setDefaultProfile(profile.profile.id);

  // Legacy absence remains personal after a managed account becomes default.
  const legacy = await mod.resolveClaudeCliExecutionProfile(store, {
    baseEnv,
    requireConnected: true,
  });
  assert.equal(legacy.profileId, "personal");
  assert.equal(
    "CLAUDE_CONFIG_DIR" in legacy.env,
    false,
    "legacy unset personal must not be rewritten to ~/.claude",
  );

  // A new-session default resolution is explicit and emits an exact,
  // sanitized child environment without mutating the parent.
  const selected = await mod.resolveClaudeCliExecutionProfile(store, {
    useDefault: true,
    baseEnv,
    requireConnected: true,
  });
  assert.equal(selected.profileId, PROFILE_ID);
  assert.equal(selected.label, "Native account");
  assert.equal(selected.managed, true);
  assert.equal(selected.connected, true);
  assert.equal(selected.env.CLAUDE_CONFIG_DIR, profileConfigDir);
  assert.equal(selected.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(baseEnv.CLAUDE_CONFIG_DIR, "/wrong/config");

  // If the app inherited an explicit legacy selector, personal preserves that
  // exact canonical directory instead of falling back to ~/.claude.
  const inheritedRoot = path.join(TMP, "inherited-store");
  const inheritedConfig = path.join(TMP, "inherited-config");
  privateDir(inheritedConfig);
  const inheritedStore = new mod.ClaudeCliAccountProfileStore(inheritedRoot, {
    personalConfigDir: inheritedConfig,
    personalConfigDirEnv: inheritedConfig,
    authChecker: () => ({ connected: true }),
  });
  const inheritedPersonal = await mod.resolveClaudeCliExecutionProfile(
    inheritedStore,
    { baseEnv },
  );
  assert.equal(inheritedPersonal.profileId, "personal");
  assert.equal(inheritedPersonal.env.CLAUDE_CONFIG_DIR, inheritedConfig);

  // Managed selectors are NFC-normalized before they become part of the
  // installed CLI's Keychain lookup. An inherited personal selector remains
  // byte-for-byte unchanged so upgrading does not silently select a different
  // legacy credential namespace.
  const decomposedPersonal = path.join(TMP, "Cafe\u0301-personal");
  const decomposedManagedRoot = path.join(TMP, "Cafe\u0301-managed");
  privateDir(decomposedPersonal);
  const unicodeStore = new mod.ClaudeCliAccountProfileStore(
    decomposedManagedRoot,
    {
      personalConfigDir: decomposedPersonal,
      personalConfigDirEnv: decomposedPersonal,
      idFactory: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      authChecker: () => ({ connected: true }),
    },
  );
  assert.equal(
    unicodeStore.rootDir,
    decomposedManagedRoot.normalize("NFC"),
    "managed root must be NFC-normalized",
  );
  const unicodePersonal = await mod.resolveClaudeCliExecutionProfile(
    unicodeStore,
    { baseEnv },
  );
  assert.equal(
    unicodePersonal.env.CLAUDE_CONFIG_DIR,
    decomposedPersonal,
    "personal inherited selector must retain its exact Unicode spelling",
  );
  const unicodeManaged = await unicodeStore.createProfile({
    label: "Unicode managed",
  });
  const unicodeManagedConfig = mod.claudeCliManagedProfileConfigDir(
    unicodeStore.rootDir,
    unicodeManaged.profile.id,
  );
  assert.equal(
    unicodeManagedConfig,
    unicodeManagedConfig.normalize("NFC"),
    "managed profile selectors must be NFC-normalized",
  );

  assert.equal(mod.frozenClaudeCliProfileId(undefined), "personal");
  assert.equal(mod.frozenClaudeCliProfileId(null), "personal");
  assert.equal(mod.frozenClaudeCliProfileId(PROFILE_ID), PROFILE_ID);
  assert.equal(
    mod.preserveFrozenClaudeCliProfileId(PROFILE_ID, PROFILE_ID),
    PROFILE_ID,
  );
  assert.equal(
    mod.preserveFrozenClaudeCliProfileId(undefined, undefined),
    "personal",
  );
  assert.throws(
    () => mod.preserveFrozenClaudeCliProfileId(PROFILE_ID, OTHER_ID),
    /changed during one frozen execution/i,
  );

  // Leases are owner-stable and reference-counted. A profile cannot be
  // deleted or newly acquired while an exclusive deletion guard owns it.
  const releaseOne = leases.acquire(PROFILE_ID, "manager:run-1");
  const releaseDuplicate = leases.acquire(PROFILE_ID, "manager:run-1");
  const releaseTwo = leases.acquire(PROFILE_ID, "terminal:pane-1");
  assert.equal(leases.isLeased(PROFILE_ID), true);
  assert.deepEqual(leases.owners(PROFILE_ID), [
    "manager:run-1",
    "terminal:pane-1",
  ]);
  assert.equal(leases.profileForOwner("manager:run-1"), PROFILE_ID);
  assert.throws(
    () => leases.acquire(OTHER_ID, "manager:run-1"),
    /already pinned/i,
  );
  assert.throws(() => leases.acquire(PROFILE_ID, "bad\u0000owner"), /bounded/i);
  assert.equal(
    (await store.inspect()).profiles.find((row) => row.id === PROFILE_ID).inUse,
    true,
  );

  await store.setDefaultProfile("personal");
  await assert.rejects(
    () => store.deleteProfile(PROFILE_ID),
    /active and cannot be deleted/i,
  );
  releaseOne();
  releaseOne();
  releaseDuplicate();
  assert.equal(leases.isLeased(PROFILE_ID), true);
  releaseTwo();
  assert.equal(leases.isLeased(PROFILE_ID), false);

  let finishExclusive;
  const exclusive = leases.runWhileUnleased(
    PROFILE_ID,
    () =>
      new Promise((resolve) => {
        finishExclusive = resolve;
      }),
  );
  assert.throws(
    () => leases.acquire(PROFILE_ID, "late-launch"),
    /being deleted/i,
  );
  await assert.rejects(
    () => leases.runWhileUnleased(PROFILE_ID, async () => undefined),
    /active and cannot be deleted/i,
  );
  finishExclusive();
  await exclusive;

  const deleted = await store.deleteProfile(PROFILE_ID);
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(profileConfigDir), false);

  const disconnected = await store.createProfile({ label: "Needs login" });
  const unready = await mod.resolveClaudeCliExecutionProfile(store, {
    profileId: disconnected.profile.id,
    baseEnv,
  });
  assert.equal(unready.connected, false);
  await assert.rejects(
    () =>
      mod.resolveClaudeCliExecutionProfile(store, {
        profileId: disconnected.profile.id,
        baseEnv,
        requireConnected: true,
      }),
    /not connected/i,
  );

  // Sweeping releases only terminal-owned leases whose pane is gone; Cora run
  // owners are outside the prefix and survive even when absent from the set.
  const releaseSwept = leases.acquire(PROFILE_ID, "terminal:pane-gone");
  leases.acquire(OTHER_ID, "terminal:pane-live");
  leases.acquire(PROFILE_ID, "manager:run-2");
  assert.deepEqual(
    leases.sweep(new Set(["terminal:pane-live"])),
    ["terminal:pane-gone"],
  );
  assert.deepEqual(leases.owners(PROFILE_ID), ["manager:run-2"]);
  assert.equal(leases.isLeased(OTHER_ID), true);
  releaseSwept();
  assert.deepEqual(leases.owners(PROFILE_ID), ["manager:run-2"], "a swept release is a no-op");
  leases.clear();

  leases.acquire("personal", "legacy-session");
  assert.equal(leases.isLeased("personal"), true);
  leases.clear();
  assert.equal(leases.isLeased("personal"), false);
  assert.equal(mod.isPersonalClaudeCliProfile("personal"), true);
  assert.equal(mod.isPersonalClaudeCliProfile(OTHER_ID), false);

  // Production routing is deliberately funneled through the process-wide
  // runtime module. PTY needs the pure env builder for its final overlay; all
  // other launch surfaces must depend on the runtime rather than constructing
  // stores or selectors ad hoc.
  const srcRoot = path.join(ROOT, "src");
  const sourceFiles = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
        sourceFiles.push(file);
      }
    }
  };
  visit(srcRoot);
  const externalReferences = sourceFiles.filter((file) => {
    if (path.basename(file).startsWith("claude-cli-")) return false;
    const text = fs.readFileSync(file, "utf8");
    return /(?:from\s+|import\s*\(\s*)["'][^"']*claude-cli-(?:account-profiles|profile-execution|profile-environment)[^"']*["']/.test(
      text,
    );
  });
  assert.deepEqual(
    externalReferences.map((file) => path.relative(ROOT, file)).sort(),
    [
      // The unified Anthropic account service, its startup pass and the
      // credential mirror own the two halves of an account; they read the
      // store's directories and never launch anything.
      "src/main/orchestration/anthropic-account-migration.ts",
      "src/main/orchestration/anthropic-accounts.ts",
      "src/main/orchestration/native-claude-profile-runtime.ts",
      "src/main/orchestration/native-cli-accounts.ts",
      // Type-only import of the execution-profile shape; resolution still
      // funnels through native-claude-profile-runtime.
      "src/main/orchestration/native-cli-shell-defaults.ts",
      "src/main/pty-manager.ts",
      // Read-only transcript discovery needs the personal Claude projects
      // root; it is analytics, not an execution or launch surface.
      "src/main/usage-analytics.ts",
    ],
  );

  console.log(
    "PASS native Claude execution profiles: exact isolated environment, credential stripping, legacy/frozen identity, and deletion-safe leases",
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
