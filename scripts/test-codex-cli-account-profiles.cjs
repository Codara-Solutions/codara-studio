#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-cli-profiles-"));
const OUT = path.join(TMP, "codex-cli-account-profiles.cjs");

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
  outfile: OUT,
});

const mod = require(OUT);

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function privateFile(file, value = "not-json SECRET_TOKEN_MARKER") {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

async function main() {
  const storeRoot = path.join(TMP, "store");
  const personalHome = path.join(TMP, "personal-home");
  privateFile(path.join(personalHome, "auth.json"));
  let idIndex = 0;
  let tick = 0;
  const store = new mod.CodexCliAccountProfileStore(storeRoot, {
    personalHomeDir: personalHome,
    idFactory: () => IDS[idIndex++],
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)),
  });

  // Synthetic personal is the only initial row. Its auth bytes and every
  // filesystem path stay out of the sanitized projection.
  const initial = await store.inspect();
  assert.equal(initial.defaultProfileId, "personal");
  assert.deepEqual(initial.profiles, [
    {
      id: "personal",
      label: "Existing Codex login",
      managed: false,
      isDefault: true,
      connected: true,
      inUse: false,
    },
  ]);
  const initialJson = JSON.stringify(initial);
  assert.equal(initialJson.includes("SECRET_TOKEN_MARKER"), false);
  assert.equal(initialJson.includes(storeRoot), false);
  assert.equal(initialJson.includes(personalHome), false);
  assert.equal(initialJson.includes("auth.json"), false);

  // Legacy absence is intentionally personal, while useDefault is an explicit
  // new-session operation.
  assert.equal((await store.resolveProfile()).profileId, "personal");
  assert.equal((await store.resolveProfile({ profileId: null })).profileId, "personal");
  assert.equal((await store.resolveProfile({ profileId: "" })).profileId, "personal");

  const alpha = await store.createProfile({ label: "  Work Codex  " });
  assert.equal(alpha.profile.id, IDS[0]);
  assert.equal(alpha.profile.label, "Work Codex");
  assert.equal(alpha.snapshot.defaultProfileId, "personal");
  const alphaPaths = mod.codexCliManagedProfilePaths(storeRoot, alpha.profile.id);
  assert.equal(path.dirname(alphaPaths.homeDir), path.join(storeRoot, "accounts"));
  if (process.platform !== "win32") {
    assert.equal(mode(storeRoot), 0o700);
    assert.equal(mode(path.join(storeRoot, "accounts")), 0o700);
    assert.equal(mode(alphaPaths.homeDir), 0o700);
    assert.equal(mode(path.join(storeRoot, "account-profiles.json")), 0o600);
  }
  assert.equal(
    (await store.inspect()).profiles.find((row) => row.id === alpha.profile.id)
      .connected,
    false,
  );

  // Auth status is token-blind: any private regular auth.json is connected,
  // even malformed/non-JSON bytes. No token is read into a projection.
  privateFile(alphaPaths.authFile);
  let inspection = await store.inspect();
  const alphaRow = inspection.profiles.find((row) => row.id === alpha.profile.id);
  assert.equal(alphaRow.connected, true);
  assert.equal(JSON.stringify(inspection).includes("SECRET_TOKEN_MARKER"), false);

  // Group-readable auth is unsafe, not connected. Restore before routing it.
  if (process.platform !== "win32") {
    fs.chmodSync(alphaPaths.authFile, 0o644);
    const unsafe = await store.inspect();
    assert.deepEqual(
      unsafe.profiles.find((row) => row.id === alpha.profile.id),
      {
        id: alpha.profile.id,
        label: "Work Codex",
        managed: true,
        isDefault: false,
        connected: false,
        inUse: false,
        error: "Credential file is unsafe",
      },
    );
    await rejects(
      () => store.setDefaultProfile(alpha.profile.id),
      /must be connected/i,
    );
    fs.chmodSync(alphaPaths.authFile, 0o600);
  }

  await store.setDefaultProfile(alpha.profile.id);
  assert.equal(
    (await store.resolveProfile({ useDefault: true })).profileId,
    alpha.profile.id,
  );
  assert.equal((await store.resolveProfile()).profileId, "personal");
  assert.equal(
    (await store.resolveProfile({ profileId: alpha.profile.id, requireConnected: true }))
      .homeDir,
    alphaPaths.homeDir,
  );

  await rejects(
    () => store.deleteProfile(alpha.profile.id),
    /current default/i,
  );
  await store.setDefaultProfile("personal");

  const renamed = await store.renameProfile(alpha.profile.id, "Office");
  assert.equal(renamed.label, "Office");
  assert.ok(renamed.updatedAt >= renamed.createdAt);

  for (const invalid of [
    "",
    " ".repeat(4),
    "bad\u0000label",
    "x".repeat(mod.CODEX_CLI_PROFILE_LABEL_MAX_LENGTH + 1),
  ]) {
    await rejects(() => store.createProfile({ label: invalid }), /label/i);
  }
  assert.throws(
    () => mod.codexCliManagedProfilePaths(storeRoot, "../escape"),
    /UUIDv4/i,
  );
  assert.throws(
    () => mod.normalizeCodexCliProfileId("../../escape"),
    /UUIDv4/i,
  );

  // Crash before metadata commit: profile is still registered and its staged
  // home is restored. No credential bytes are copied.
  const alphaStage = path.join(
    storeRoot,
    "accounts",
    `.${alpha.profile.id}.deleting-deadbeef`,
  );
  fs.renameSync(alphaPaths.homeDir, alphaStage);
  const restored = await store.reconcile();
  assert.deepEqual(restored.restoredProfileIds, [alpha.profile.id]);
  assert.equal(fs.existsSync(alphaPaths.homeDir), true);
  assert.equal(fs.readFileSync(alphaPaths.authFile, "utf8").includes("SECRET_TOKEN_MARKER"), true);

  // Crash after metadata commit: the staged home is removed because the
  // profile no longer exists in metadata.
  const beta = await store.createProfile({ label: "Disposable" });
  const betaPaths = mod.codexCliManagedProfilePaths(storeRoot, beta.profile.id);
  privateFile(betaPaths.authFile, "SECOND_SECRET_MARKER");
  const disk = JSON.parse(
    fs.readFileSync(path.join(storeRoot, "account-profiles.json"), "utf8"),
  );
  disk.profiles = disk.profiles.filter((profile) => profile.id !== beta.profile.id);
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
  fs.renameSync(betaPaths.homeDir, betaStage);
  const removed = await store.reconcile();
  assert.ok(removed.removedDeletingDirectories.includes(betaStageName));
  assert.equal(fs.existsSync(betaStage), false);

  // Orphans are reported and preserved because they may be the sole copy of a
  // login after a metadata-write crash.
  const orphan = path.join(storeRoot, "accounts", IDS[4]);
  fs.mkdirSync(orphan, { mode: 0o700 });
  privateFile(path.join(orphan, "auth.json"), "ORPHAN_SECRET_MARKER");
  const orphanResult = await store.reconcile();
  assert.ok(orphanResult.orphanProfileIds.includes(IDS[4]));
  assert.equal(fs.existsSync(path.join(orphan, "auth.json")), true);

  // Normal staged deletion is exact and leaves other homes untouched.
  const gamma = await store.createProfile({ label: "Delete me" });
  const gammaPaths = mod.codexCliManagedProfilePaths(storeRoot, gamma.profile.id);
  privateFile(gammaPaths.authFile, "GAMMA_SECRET");
  const deleted = await store.deleteProfile(gamma.profile.id);
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(gammaPaths.homeDir), false);
  assert.equal(fs.existsSync(alphaPaths.homeDir), true);
  assert.equal((await store.deleteProfile(gamma.profile.id)).deleted, false);
  await rejects(() => store.deleteProfile("personal"), /cannot be deleted/i);

  // Profile-home and auth symlinks are never followed.
  const symlinkProfile = await store.createProfile({ label: "Symlink target" });
  const symlinkPaths = mod.codexCliManagedProfilePaths(storeRoot, symlinkProfile.profile.id);
  fs.rmSync(symlinkPaths.homeDir, { recursive: true, force: true });
  fs.symlinkSync(personalHome, symlinkPaths.homeDir, "dir");
  await rejects(
    () => store.resolveProfile({ profileId: symlinkProfile.profile.id }),
    /unsafe|symlink/i,
  );
  await rejects(
    () => store.deleteProfile(symlinkProfile.profile.id),
    /unsafe|symlink/i,
  );

  // A symlinked root/accounts/metadata surface is rejected before mutation.
  const linkedRootTarget = path.join(TMP, "linked-root-target");
  fs.mkdirSync(linkedRootTarget, { mode: 0o700 });
  const linkedRoot = path.join(TMP, "linked-root");
  fs.symlinkSync(linkedRootTarget, linkedRoot, "dir");
  const rootAttack = new mod.CodexCliAccountProfileStore(linkedRoot, {
    personalHomeDir: personalHome,
  });
  await rejects(() => rootAttack.createProfile({ label: "Nope" }), /unsafe|symlink/i);

  const accountsAttackRoot = path.join(TMP, "accounts-attack");
  fs.mkdirSync(accountsAttackRoot, { mode: 0o700 });
  fs.symlinkSync(personalHome, path.join(accountsAttackRoot, "accounts"), "dir");
  const accountsAttack = new mod.CodexCliAccountProfileStore(accountsAttackRoot, {
    personalHomeDir: personalHome,
  });
  await rejects(
    () => accountsAttack.createProfile({ label: "Nope" }),
    /unsafe|symlink/i,
  );

  const metadataAttackRoot = path.join(TMP, "metadata-attack");
  fs.mkdirSync(metadataAttackRoot, { mode: 0o700 });
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
  const metadataAttack = new mod.CodexCliAccountProfileStore(metadataAttackRoot, {
    personalHomeDir: personalHome,
  });
  await rejects(() => metadataAttack.snapshot(), /unsafe|symlink/i);

  // Injected checker receives main-only paths, while its exception and inputs
  // cannot escape through inspection.
  const checkerRoot = path.join(TMP, "checker");
  const seen = [];
  const checkerStore = new mod.CodexCliAccountProfileStore(checkerRoot, {
    personalHomeDir: personalHome,
    idFactory: () => IDS[3],
    authChecker: async (input) => {
      seen.push(input);
      if (input.managed) throw new Error("SECRET_FROM_CHECKER");
      return { connected: true };
    },
  });
  await checkerStore.createProfile({ label: "Checker" });
  const checked = await checkerStore.inspect();
  assert.ok(seen.some((input) => input.authFile.endsWith("auth.json")));
  const checkedJson = JSON.stringify(checked);
  assert.equal(checkedJson.includes("SECRET_FROM_CHECKER"), false);
  assert.equal(checkedJson.includes(checkerRoot), false);

  // Studio can be launched from a terminal that already sources the generated
  // env.sh, so CODEX_HOME may arrive pointing at the Active managed account —
  // for Codex it points at the pointer symlink itself. Neither is the user's
  // personal login.
  {
    const codaraHome = path.join(TMP, "env-loop", "Codara");
    const managed = path.join(codaraHome, "codex-cli", "accounts", IDS[0]);
    const pointerDir = path.join(codaraHome, "cli", "active");
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(pointerDir, { recursive: true });
    const pointer = path.join(pointerDir, "codex");
    fs.symlinkSync(managed, pointer, "dir");
    const ownDir = path.join(TMP, "env-loop", "my-own-codex");
    fs.mkdirSync(ownDir, { recursive: true });
    const personalDefault = path.resolve(path.join(os.homedir(), ".codex"));
    const previousHome = process.env.CODARA_HOME_DIR;
    const previousSelector = process.env.CODEX_HOME;
    process.env.CODARA_HOME_DIR = codaraHome;
    try {
      for (const selector of [managed, pointer]) {
        process.env.CODEX_HOME = selector;
        assert.equal(mod.defaultPersonalCodexHomeDir(), personalDefault);
        assert.equal(
          new mod.CodexCliAccountProfileStore(path.join(TMP, "env-loop", "store"))
            .personalHomeDir,
          personalDefault,
        );
      }
      // A directory of the user's own still selects the personal login.
      process.env.CODEX_HOME = ownDir;
      assert.equal(mod.defaultPersonalCodexHomeDir(), ownDir);
      assert.equal(
        new mod.CodexCliAccountProfileStore(path.join(TMP, "env-loop", "store"))
          .personalHomeDir,
        ownDir,
      );
    } finally {
      if (previousHome === undefined) delete process.env.CODARA_HOME_DIR;
      else process.env.CODARA_HOME_DIR = previousHome;
      if (previousSelector === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousSelector;
    }
  }

  console.log(
    "PASS native Codex account store: private metadata, token-blind status, path safety, defaults, staged deletion recovery, and leak-free projection",
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
