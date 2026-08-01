#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-codex-cli-execution-"),
);
const OUT = path.join(TMP, "codex-cli-profile-execution.cjs");
const STORE_OUT = path.join(TMP, "codex-cli-account-profiles.cjs");

buildSync({
  entryPoints: [
    path.join(
      ROOT,
      "src",
      "main",
      "orchestration",
      "codex-cli-profile-execution.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
});

buildSync({
  entryPoints: [
    path.join(
      ROOT,
      "src",
      "main",
      "orchestration",
      "codex-cli-account-profiles.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: STORE_OUT,
});

const mod = { ...require(STORE_OUT), ...require(OUT) };
const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function privateAuth(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "auth.json"), "UNREAD_SECRET", {
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    fs.chmodSync(home, 0o700);
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
  }
}

async function main() {
  const exactHome = path.join(TMP, "exact-home");
  const baseEnv = {
    PATH: "/safe/bin",
    HOME: "/do/not/change",
    SPARK_AGENT_TOKEN: "local-socket-token",
    CODEX_HOME: "/wrong/home",
    codex_access_token: "lowercase-secret",
    OPENAI_API_KEY: "api-secret",
    CodeX_Api_Key: "mixed-secret",
    AZURE_OPENAI_API_KEY: "azure-secret",
    AZURE_OPENAI_AD_TOKEN: "azure-ad-secret",
    OPENROUTER_API_KEY: "router-secret",
    SAFE_VALUE: "keep-me",
    UNDEFINED_VALUE: undefined,
  };
  const original = { ...baseEnv };
  const env = mod.buildCodexCliProfileEnvironment(baseEnv, exactHome);
  assert.deepEqual(baseEnv, original, "input environment must not be mutated");
  assert.equal(env.CODEX_HOME, exactHome);
  assert.equal(env.PATH, "/safe/bin");
  assert.equal(env.HOME, "/do/not/change");
  assert.equal(env.SPARK_AGENT_TOKEN, "local-socket-token");
  assert.equal(env.SAFE_VALUE, "keep-me");
  for (const key of Object.keys(env)) {
    assert.equal(
      mod.CODEX_CLI_CREDENTIAL_OVERRIDE_ENV_NAMES.has(key.toUpperCase()),
      false,
      `credential override survived: ${key}`,
    );
  }
  assert.equal("codex_access_token" in env, false);
  assert.equal("UNDEFINED_VALUE" in env, false);
  assert.throws(
    () => mod.buildCodexCliProfileEnvironment({}, ""),
    /non-empty/i,
  );
  assert.throws(
    () => mod.buildCodexCliProfileEnvironment({}, "relative/codex-home"),
    /absolute/i,
  );
  assert.throws(
    () =>
      mod.buildCodexCliProfileEnvironment(
        {},
        `${exactHome}${path.sep}..${path.sep}${path.basename(exactHome)}`,
      ),
    /canonical/i,
  );

  const storeRoot = path.join(TMP, "store");
  const personalHome = path.join(TMP, "personal");
  privateAuth(personalHome);
  const leases = new mod.CodexCliProfileLeaseRegistry();
  const store = new mod.CodexCliAccountProfileStore(storeRoot, {
    personalHomeDir: personalHome,
    idFactory: (() => {
      const ids = [PROFILE_ID, OTHER_ID];
      return () => ids.shift();
    })(),
    leases,
  });
  const profile = await store.createProfile({ label: "Native account" });
  const profilePaths = mod.codexCliManagedProfilePaths(
    storeRoot,
    profile.profile.id,
  );
  privateAuth(profilePaths.homeDir);
  await store.setDefaultProfile(profile.profile.id);

  // Legacy absence is personal even after a managed profile becomes default.
  const legacy = await mod.resolveCodexCliExecutionProfile(store, {
    baseEnv,
    requireConnected: true,
  });
  assert.equal(legacy.profileId, "personal");
  assert.equal(legacy.env.CODEX_HOME, personalHome);

  // New-session default resolution is explicit and exact.
  const selected = await mod.resolveCodexCliExecutionProfile(store, {
    useDefault: true,
    baseEnv,
    requireConnected: true,
  });
  assert.equal(selected.profileId, PROFILE_ID);
  assert.equal(selected.label, "Native account");
  assert.equal(selected.managed, true);
  assert.equal(selected.connected, true);
  assert.equal(selected.env.CODEX_HOME, profilePaths.homeDir);
  assert.equal(selected.env.OPENAI_API_KEY, undefined);
  assert.equal(baseEnv.CODEX_HOME, "/wrong/home");

  assert.equal(mod.frozenCodexCliProfileId(undefined), "personal");
  assert.equal(mod.frozenCodexCliProfileId(null), "personal");
  assert.equal(mod.frozenCodexCliProfileId(PROFILE_ID), PROFILE_ID);
  assert.equal(
    mod.preserveFrozenCodexCliProfileId(PROFILE_ID, PROFILE_ID),
    PROFILE_ID,
  );
  assert.equal(
    mod.preserveFrozenCodexCliProfileId(undefined, undefined),
    "personal",
  );
  assert.throws(
    () => mod.preserveFrozenCodexCliProfileId(PROFILE_ID, OTHER_ID),
    /changed during one frozen execution/i,
  );

  // Leases are exact, owner-stable, ref-counted by owner identity, and release
  // functions are idempotent.
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

  let inspected = await store.inspect();
  assert.equal(
    inspected.profiles.find((row) => row.id === PROFILE_ID).inUse,
    true,
  );
  // Default rotation is deliberately allowed while leased: existing owners
  // remain frozen; only future default resolutions change.
  await store.setDefaultProfile("personal");
  assert.equal((await store.snapshot()).defaultProfileId, "personal");
  const retriedFrozen = await mod.resolveCodexCliExecutionProfile(store, {
    profileId: selected.profileId,
    baseEnv,
    requireConnected: true,
  });
  const futureDefault = await mod.resolveCodexCliExecutionProfile(store, {
    useDefault: true,
    baseEnv,
    requireConnected: true,
  });
  assert.equal(
    retriedFrozen.env.CODEX_HOME,
    profilePaths.homeDir,
    "retry/resume must retain the launch-time profile after default changes",
  );
  assert.equal(
    futureDefault.profileId,
    "personal",
    "only future launches should observe the changed default",
  );
  await assert.rejects(
    () => store.deleteProfile(PROFILE_ID),
    /active and cannot be deleted/i,
  );

  releaseOne();
  releaseOne();
  // A duplicate acquire reference-counts the same owner. Releasing both still
  // leaves the independent terminal owner protecting the profile.
  releaseDuplicate();
  assert.equal(leases.isLeased(PROFILE_ID), true);
  await assert.rejects(
    () => store.deleteProfile(PROFILE_ID),
    /active and cannot be deleted/i,
  );
  releaseTwo();
  assert.equal(leases.isLeased(PROFILE_ID), false);
  assert.deepEqual(leases.owners(PROFILE_ID), []);

  // Spawn callers transfer a lease only after acquiring it and must release
  // the same handle when process construction throws.
  const failedSpawnRelease = leases.acquire(
    PROFILE_ID,
    "terminal:failed-spawn",
  );
  try {
    throw new Error("synthetic spawn failure");
  } catch {
    failedSpawnRelease();
  }
  assert.equal(
    leases.isLeased(PROFILE_ID),
    false,
    "failed spawn must not strand a deletion-blocking lease",
  );

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
  finishExclusive();
  await exclusive;

  const deleted = await store.deleteProfile(PROFILE_ID);
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(profilePaths.homeDir), false);

  // Disconnected explicitly-selected profiles can be inspected for login
  // setup, but cannot be required for execution.
  const disconnected = await store.createProfile({ label: "Needs login" });
  const unready = await mod.resolveCodexCliExecutionProfile(store, {
    profileId: disconnected.profile.id,
    baseEnv,
  });
  assert.equal(unready.connected, false);
  await assert.rejects(
    () =>
      mod.resolveCodexCliExecutionProfile(store, {
        profileId: disconnected.profile.id,
        baseEnv,
        requireConnected: true,
      }),
    /not connected/i,
  );

  leases.acquire("personal", "legacy-session");
  assert.equal(leases.isLeased("personal"), true);
  leases.clear();
  assert.equal(leases.isLeased("personal"), false);

  console.log(
    "PASS native Codex execution profiles: exact isolated environment, credential stripping, legacy/frozen resolution, and deletion-safe leases",
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
