#!/usr/bin/env node
"use strict";

// Guard for the shared CLI state layer (native-cli-shared-state.ts): managed
// Grok accounts share explicitly allowlisted user-state surfaces with the
// personal home via symlinks, keeping credentials and identity per-account.
// Claude and Codex deliberately are not part of this layer: each runs every
// account in one home and switches only the login inside it, so a managed
// slot is a vault, never a second home. Runs entirely against temp dirs,
// never the real CLI homes or ~/.codarastudio.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-native-cli-shared-state-"));

function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  buildSync({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
  });
  return require(outfile);
}

const shared = bundle("native-cli-shared-state", "native-cli-shared-state.ts");
const claudeStores = bundle("claude-cli-account-profiles", "claude-cli-account-profiles.ts");
const codexStores = bundle("codex-cli-account-profiles", "codex-cli-account-profiles.ts");

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function isLinkTo(linkPath, target) {
  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) return false;
  return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(target);
}

function outcomeOf(result, name) {
  const entry = result.entries.find((row) => row.name === name);
  assert.ok(entry, `expected a result entry for ${name}`);
  return entry.outcome;
}

function backupsIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".codara-backup-"));
}

function stashRootsIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith(".codara-stash-"));
}

async function testGrokFreshLinkSet() {
  const personal = path.join(TMP, "grok-fresh", "personal");
  const managed = path.join(TMP, "grok-fresh", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "config.toml"), 'model = "grok"\n', { mode: 0o600 });
  fs.mkdirSync(path.join(personal, "sessions", "enc"), { recursive: true });
  fs.writeFileSync(path.join(personal, "sessions", "enc", "keep.jsonl"), "personal transcript\n");
  // Private names are never linked or moved in either direction.
  fs.writeFileSync(path.join(personal, "auth.json"), "PERSONAL_LOGIN", { mode: 0o600 });
  fs.writeFileSync(path.join(managed, "auth.json"), "MANAGED_LOGIN", { mode: 0o600 });

  const result = await shared.ensureSharedCliState({
    managedDir: managed,
    personalDir: personal,
    runtime: "grok",
  });
  assert.equal(result.skipped, undefined);

  for (const spec of shared.GROK_CLI_SHARED_STATE) {
    if (spec.kind !== "dir") continue;
    assert.ok(isLinkTo(path.join(managed, spec.name), path.join(personal, spec.name)), `${spec.name} must be a link`);
    assert.ok(fs.statSync(path.join(personal, spec.name)).isDirectory(), `${spec.name} personal target must exist`);
    assert.equal(outcomeOf(result, spec.name), "linked");
  }
  assert.ok(isLinkTo(path.join(managed, "config.toml"), path.join(personal, "config.toml")));
  // A file link is skipped while the personal target is missing.
  assert.equal(fs.existsSync(path.join(managed, "AGENTS.md")), false);
  assert.equal(outcomeOf(result, "AGENTS.md"), "skipped-missing");
  assert.equal(fs.readFileSync(path.join(managed, "config.toml"), "utf8"), 'model = "grok"\n');
  assert.equal(fs.readFileSync(path.join(managed, "auth.json"), "utf8"), "MANAGED_LOGIN");
  assert.equal(fs.lstatSync(path.join(managed, "auth.json")).isSymbolicLink(), false);

  const again = await shared.ensureSharedCliState({
    managedDir: managed,
    personalDir: personal,
    runtime: "grok",
  });
  assert.equal(outcomeOf(again, "sessions"), "linked");
  assert.equal(outcomeOf(again, "config.toml"), "linked");
  assert.deepEqual(backupsIn(personal), []);
  console.log("PASS fresh managed dir gets the allowlisted link set and nothing else");
}

async function testClobberHealing() {
  const personal = path.join(TMP, "grok-clobber", "personal");
  const managed = path.join(TMP, "grok-clobber", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });

  // Byte-equal clobber: relink without a backup.
  fs.writeFileSync(path.join(personal, "config.toml"), 'theme = "dark"');
  fs.writeFileSync(path.join(managed, "config.toml"), 'theme = "dark"');
  let result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "config.toml"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "config.toml"), path.join(personal, "config.toml")));
  assert.deepEqual(backupsIn(personal), []);

  // Divergent, managed newer: managed content wins, personal copy backed up.
  fs.rmSync(path.join(managed, "config.toml"));
  fs.writeFileSync(path.join(managed, "config.toml"), 'theme = "light"');
  const old = new Date(Date.now() - 100_000);
  fs.utimesSync(path.join(personal, "config.toml"), old, old);
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "config.toml"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "config.toml"), path.join(personal, "config.toml")));
  assert.equal(fs.readFileSync(path.join(personal, "config.toml"), "utf8"), 'theme = "light"');
  let backups = backupsIn(personal);
  assert.equal(backups.length, 1, "the losing personal content must be preserved");
  assert.equal(fs.readFileSync(path.join(personal, backups[0]), "utf8"), 'theme = "dark"');
  fs.rmSync(path.join(personal, backups[0]));

  // Divergent, personal newer: personal content survives, managed copy backed up.
  fs.rmSync(path.join(managed, "config.toml"));
  fs.writeFileSync(path.join(managed, "config.toml"), 'theme = "stale"');
  fs.utimesSync(path.join(managed, "config.toml"), old, old);
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "config.toml"), "healed-file");
  assert.equal(fs.readFileSync(path.join(personal, "config.toml"), "utf8"), 'theme = "light"');
  backups = backupsIn(personal);
  assert.equal(backups.length, 1, "the losing managed content must be preserved");
  assert.equal(fs.readFileSync(path.join(personal, backups[0]), "utf8"), 'theme = "stale"');

  // Clobber with no personal target: the managed content MOVES to personal.
  fs.writeFileSync(path.join(managed, "AGENTS.md"), "managed instructions\n");
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "AGENTS.md"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "AGENTS.md"), path.join(personal, "AGENTS.md")));
  assert.equal(fs.readFileSync(path.join(personal, "AGENTS.md"), "utf8"), "managed instructions\n");

  // A wrong-target link is retargeted at the personal equivalent.
  const elsewhere = path.join(TMP, "grok-clobber", "elsewhere.toml");
  fs.writeFileSync(elsewhere, "");
  fs.rmSync(path.join(managed, "config.toml"));
  fs.symlinkSync(elsewhere, path.join(managed, "config.toml"));
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.ok(isLinkTo(path.join(managed, "config.toml"), path.join(personal, "config.toml")));
  console.log("PASS clobbered files heal: byte-equal relinks, newest wins with a backup, wrong targets retarget");
}

async function testRealDirectoryMigration() {
  const personal = path.join(TMP, "grok-migrate", "personal");
  const managed = path.join(TMP, "grok-migrate", "managed");
  fs.mkdirSync(path.join(personal, "sessions", "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "sessions", "enc", "both.jsonl"), "personal copy\n");
  fs.mkdirSync(path.join(managed, "sessions", "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(managed, "sessions", "enc", "only-managed.jsonl"), "managed transcript\n");
  fs.writeFileSync(path.join(managed, "sessions", "enc", "both.jsonl"), "managed copy\n");

  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "sessions"), "merged-dir");
  assert.ok(isLinkTo(path.join(managed, "sessions"), path.join(personal, "sessions")));
  // The unique transcript moved into the shared store; the collision kept the
  // PERSONAL copy and stashed the managed one.
  assert.equal(
    fs.readFileSync(path.join(personal, "sessions", "enc", "only-managed.jsonl"), "utf8"),
    "managed transcript\n",
  );
  assert.equal(
    fs.readFileSync(path.join(personal, "sessions", "enc", "both.jsonl"), "utf8"),
    "personal copy\n",
  );
  const stashRoots = stashRootsIn(managed);
  assert.equal(stashRoots.length, 1, "colliding managed entries must be stashed");
  assert.equal(
    fs.readFileSync(path.join(managed, stashRoots[0], "sessions", "enc", "both.jsonl"), "utf8"),
    "managed copy\n",
  );
  assert.deepEqual(
    fs.readdirSync(managed).filter((name) => name.includes(".migrating-")),
    [],
  );
  console.log("PASS a real sessions/ directory migrates: transcripts merge, collisions keep personal and stash managed");
}

async function testInterruptedMigrationRecovery() {
  // A crash inside migrateRealDirectory leaves the link installed and the
  // unmerged remainder in a `.sessions.migrating-*` stage. The next heal must
  // finish the merge instead of declaring the (correct) link done.
  const personal = path.join(TMP, "grok-recover", "personal");
  const managed = path.join(TMP, "grok-recover", "managed");
  fs.mkdirSync(path.join(personal, "sessions"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(personal, "sessions"), path.join(managed, "sessions"));
  const stage = path.join(managed, ".sessions.migrating-deadbeef");
  fs.mkdirSync(path.join(stage, "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, "enc", "stranded.jsonl"), "stranded transcript\n");

  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "grok" });
  assert.equal(outcomeOf(result, "sessions"), "linked");
  assert.equal(
    fs.readFileSync(path.join(personal, "sessions", "enc", "stranded.jsonl"), "utf8"),
    "stranded transcript\n",
    "an interrupted migration's transcripts must reach the shared store",
  );
  assert.equal(fs.existsSync(stage), false, "the recovered stage must be cleaned up");
  console.log("PASS an interrupted migration stage is recovered on the next heal");
}

async function testGuards() {
  const dir = path.join(TMP, "guards", "same");
  fs.mkdirSync(dir, { recursive: true });
  const same = await shared.ensureSharedCliState({ managedDir: dir, personalDir: dir, runtime: "grok" });
  assert.equal(same.skipped, "unsafe-input");
  assert.deepEqual(fs.readdirSync(dir), []);

  // win32 keeps the old fully-isolated behavior: the pass is a recorded no-op.
  const personal = path.join(TMP, "guards", "personal");
  const managed = path.join(TMP, "guards", "managed");
  fs.mkdirSync(personal, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(personal, "config.toml"), "");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const skipped = await shared.ensureSharedCliState({
      managedDir: managed,
      personalDir: personal,
      runtime: "grok",
    });
    assert.equal(skipped.skipped, "win32");
    assert.deepEqual(skipped.entries, []);
    assert.deepEqual(fs.readdirSync(managed), []);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  console.log("PASS guard rails: identical managed/personal dirs refuse, win32 is a recorded no-op");
}

async function testClaudeStoreWiring() {
  const storeRoot = path.join(TMP, "claude-store");
  const personal = path.join(TMP, "claude-store-personal");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "settings.json"), '{"theme":"dark"}', { mode: 0o600 });
  let idIndex = 0;
  const store = new claudeStores.ClaudeCliAccountProfileStore(storeRoot, {
    personalConfigDir: personal,
    personalConfigDirEnv: null,
    idFactory: () => IDS[idIndex++],
    authChecker: () => ({ connected: true }),
  });
  const created = await store.createProfile({ label: "One home" });
  const profileDir = claudeStores.claudeCliManagedProfileConfigDir(storeRoot, created.profile.id);
  assert.deepEqual(
    fs.readdirSync(profileDir),
    [],
    "a managed Claude profile is a vault slot, never a second Claude home",
  );
  const resolved = await store.resolveProfile({ profileId: created.profile.id });
  assert.equal(resolved.configDir, personal, "every Claude profile runs in the one home");
  assert.equal(resolved.configDirEnv, null);
  assert.deepEqual(fs.readdirSync(profileDir), [], "resolving never plants links");
  console.log("PASS claude store wiring: a managed profile is a vault slot and resolves to the one home");
}

async function testCodexStoreWiring() {
  const storeRoot = path.join(TMP, "codex-store");
  const personal = path.join(TMP, "codex-store-personal");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "config.toml"), 'model = "personal"\n', { mode: 0o600 });
  const store = new codexStores.CodexCliAccountProfileStore(storeRoot, {
    personalHomeDir: personal,
    idFactory: () => IDS[0],
    authChecker: () => ({ connected: true }),
  });
  const created = await store.createProfile({ label: "Shared" });
  const { homeDir, authFile } = codexStores.codexCliManagedProfilePaths(storeRoot, created.profile.id);
  assert.deepEqual(
    fs.readdirSync(homeDir),
    [],
    "a managed Codex slot is an auth vault, never another session home",
  );
  assert.equal(
    fs.existsSync(path.join(homeDir, "sessions")),
    false,
    "session state must stay exclusively under the personal ~/.codex home",
  );
  assert.equal(fs.existsSync(authFile), false, "creation must not invent an auth.json");
  console.log("PASS codex store wiring: a fresh managed slot cannot split session state");
}

async function main() {
  await testGrokFreshLinkSet();
  await testClobberHealing();
  await testRealDirectoryMigration();
  await testInterruptedMigrationRecovery();
  await testGuards();
  await testClaudeStoreWiring();
  await testCodexStoreWiring();
  console.log("PASS native CLI shared state: allowlisted links, healing, migration, and per-account credentials");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
