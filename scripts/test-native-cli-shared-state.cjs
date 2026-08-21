#!/usr/bin/env node
"use strict";

// Guard for the shared CLI state layer (native-cli-shared-state.ts): managed
// Claude/Codex accounts share the user-state surfaces (chats, settings,
// history) with the personal home via symlinks, keeping only credentials and
// identity per-account. Runs entirely against temp dirs — never the real
// ~/.claude, ~/.codex, or ~/.Codara.

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

async function testClaudeFreshLinkSet() {
  const personal = path.join(TMP, "claude-fresh", "personal");
  const managed = path.join(TMP, "claude-fresh", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "settings.json"), '{"theme":"dark"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(personal, "settings.local.json"), '{"local":true}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(personal, "statusline-command.sh"), "#!/bin/sh\necho hi\n", { mode: 0o700 });
  fs.writeFileSync(path.join(personal, "history.jsonl"), '{"line":"A"}\n{"line":"B"}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(personal, "projects", "enc"), { recursive: true });
  fs.writeFileSync(path.join(personal, "projects", "enc", "keep.jsonl"), "personal transcript\n");
  // Unlisted / private names must never be linked or moved in either
  // direction — the live per-PID session registry especially.
  fs.mkdirSync(path.join(personal, "sessions"));
  fs.writeFileSync(path.join(personal, "sessions", "abc.json"), '{"pid":123,"status":"busy"}');
  fs.mkdirSync(path.join(personal, "statsig"));
  fs.writeFileSync(path.join(personal, "statsig", "evaluation"), "PERSONAL_ONLY");
  fs.writeFileSync(path.join(managed, ".credentials.json"), "MANAGED_CREDENTIAL", { mode: 0o600 });

  const result = await shared.ensureSharedCliState({
    managedDir: managed,
    personalDir: personal,
    runtime: "claude",
  });
  assert.equal(result.skipped, undefined);

  for (const spec of shared.CLAUDE_CLI_SHARED_STATE) {
    if (spec.kind !== "dir" || spec.heal !== "link") continue;
    assert.ok(isLinkTo(path.join(managed, spec.name), path.join(personal, spec.name)), `${spec.name} must be a link`);
    assert.ok(fs.statSync(path.join(personal, spec.name)).isDirectory(), `${spec.name} personal target must exist`);
    assert.equal(outcomeOf(result, spec.name), "linked");
  }
  // `todos` belongs to older CLIs: absent from the personal home means no
  // link at all.
  assert.equal(fs.existsSync(path.join(managed, "todos")), false);
  assert.equal(outcomeOf(result, "todos"), "skipped-missing");
  // The live session registry is PRIVATE: never linked, never entered. This
  // deserves an explicit check because the SAME name is shared for codex,
  // where sessions/ is the transcript store — for claude it is a per-PID
  // registry of RUNNING sessions.
  assert.equal(
    shared.CLAUDE_CLI_SHARED_STATE.some((spec) => spec.name === "sessions"),
    false,
    "claude sessions/ must not be in the share list",
  );
  assert.equal(fs.existsSync(path.join(managed, "sessions")), false);
  // Deliberately private despite living beside the shared settings.json.
  for (const name of ["settings.local.json", "statusline-command.sh", "image-cache"]) {
    assert.equal(
      shared.CLAUDE_CLI_SHARED_STATE.some((spec) => spec.name === name),
      false,
      `${name} must stay per-account`,
    );
    assert.equal(fs.existsSync(path.join(managed, name)), false);
  }

  assert.ok(isLinkTo(path.join(managed, "settings.json"), path.join(personal, "settings.json")));
  assert.ok(isLinkTo(path.join(managed, "history.jsonl"), path.join(personal, "history.jsonl")));
  // A file link is skipped while the personal target is missing.
  assert.equal(fs.existsSync(path.join(managed, "CLAUDE.md")), false);
  assert.equal(outcomeOf(result, "CLAUDE.md"), "skipped-missing");
  // Reading through the link sees the personal content.
  assert.equal(
    fs.readFileSync(path.join(managed, "settings.json"), "utf8"),
    '{"theme":"dark"}\n',
  );

  // Never linked, never moved: credential file stays a private managed file,
  // per-account personal names stay out of the managed dir.
  assert.equal(fs.readFileSync(path.join(managed, ".credentials.json"), "utf8"), "MANAGED_CREDENTIAL");
  assert.equal(fs.lstatSync(path.join(managed, ".credentials.json")).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(managed, "statsig")), false);
  assert.equal(fs.readFileSync(path.join(personal, "statsig", "evaluation"), "utf8"), "PERSONAL_ONLY");

  // Idempotent second pass: everything already linked, nothing backed up.
  const again = await shared.ensureSharedCliState({
    managedDir: managed,
    personalDir: personal,
    runtime: "claude",
  });
  assert.equal(outcomeOf(again, "projects"), "linked");
  assert.equal(outcomeOf(again, "settings.json"), "linked");
  assert.deepEqual(backupsIn(personal), []);
  console.log("PASS fresh managed dir gets the allowlisted link set and nothing else");
}

async function testClobberHealing() {
  const personal = path.join(TMP, "claude-clobber", "personal");
  const managed = path.join(TMP, "claude-clobber", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });

  // Byte-equal clobber: relink without a backup.
  fs.writeFileSync(path.join(personal, "settings.json"), '{"theme":"dark"}');
  fs.writeFileSync(path.join(managed, "settings.json"), '{"theme":"dark"}');
  let result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "settings.json"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "settings.json"), path.join(personal, "settings.json")));
  assert.deepEqual(backupsIn(personal), []);

  // Divergent, managed newer: managed content wins, personal copy backed up.
  fs.rmSync(path.join(managed, "settings.json"));
  fs.writeFileSync(path.join(managed, "settings.json"), '{"theme":"light"}');
  const old = new Date(Date.now() - 100_000);
  fs.utimesSync(path.join(personal, "settings.json"), old, old);
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "settings.json"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "settings.json"), path.join(personal, "settings.json")));
  assert.equal(fs.readFileSync(path.join(personal, "settings.json"), "utf8"), '{"theme":"light"}');
  let backups = backupsIn(personal);
  assert.equal(backups.length, 1, "the losing personal content must be preserved");
  assert.equal(fs.readFileSync(path.join(personal, backups[0]), "utf8"), '{"theme":"dark"}');
  fs.rmSync(path.join(personal, backups[0]));

  // Divergent, personal newer: personal content survives, managed copy backed up.
  fs.rmSync(path.join(managed, "settings.json"));
  fs.writeFileSync(path.join(managed, "settings.json"), '{"theme":"stale"}');
  fs.utimesSync(path.join(managed, "settings.json"), old, old);
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "settings.json"), "healed-file");
  assert.equal(fs.readFileSync(path.join(personal, "settings.json"), "utf8"), '{"theme":"light"}');
  backups = backupsIn(personal);
  assert.equal(backups.length, 1, "the losing managed content must be preserved");
  assert.equal(fs.readFileSync(path.join(personal, backups[0]), "utf8"), '{"theme":"stale"}');

  // Clobber with no personal target: the managed content MOVES to personal.
  fs.writeFileSync(path.join(managed, "CLAUDE.md"), "managed instructions\n");
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "CLAUDE.md"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "CLAUDE.md"), path.join(personal, "CLAUDE.md")));
  assert.equal(fs.readFileSync(path.join(personal, "CLAUDE.md"), "utf8"), "managed instructions\n");

  // A wrong-target link is retargeted at the personal equivalent.
  const elsewhere = path.join(TMP, "claude-clobber", "elsewhere.json");
  fs.writeFileSync(elsewhere, "{}");
  fs.rmSync(path.join(managed, "settings.json"));
  fs.symlinkSync(elsewhere, path.join(managed, "settings.json"));
  result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.ok(isLinkTo(path.join(managed, "settings.json"), path.join(personal, "settings.json")));
  console.log("PASS clobbered files heal: byte-equal relinks, newest wins with a backup, wrong targets retarget");
}

async function testJsonlLineUnion() {
  const personal = path.join(TMP, "claude-history", "personal");
  const managed = path.join(TMP, "claude-history", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  // The personal side deliberately lacks a trailing newline so the merge seam
  // is exercised; the managed side repeats line B so the dedupe is exercised.
  fs.writeFileSync(path.join(personal, "history.jsonl"), '{"line":"A"}\n{"line":"B"}');
  fs.writeFileSync(
    path.join(managed, "history.jsonl"),
    '{"line":"B"}\n{"line":"C"}\n{"line":"D"}\n',
  );
  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "history.jsonl"), "healed-file");
  assert.ok(isLinkTo(path.join(managed, "history.jsonl"), path.join(personal, "history.jsonl")));
  const lines = fs
    .readFileSync(path.join(personal, "history.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(lines, ['{"line":"A"}', '{"line":"B"}', '{"line":"C"}', '{"line":"D"}']);

  // The codex session index gets the same lossless union: a compacted side
  // never erases the other side's exclusive lines.
  const codexPersonal = path.join(TMP, "codex-index", "personal");
  const codexManaged = path.join(TMP, "codex-index", "managed");
  fs.mkdirSync(codexPersonal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexManaged, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexPersonal, "session_index.jsonl"), '{"id":"X"}\n');
  fs.writeFileSync(path.join(codexManaged, "session_index.jsonl"), '{"id":"X"}\n{"id":"Y"}\n');
  const codexResult = await shared.ensureSharedCliState({
    managedDir: codexManaged,
    personalDir: codexPersonal,
    runtime: "codex",
  });
  assert.equal(outcomeOf(codexResult, "session_index.jsonl"), "healed-file");
  assert.ok(
    isLinkTo(
      path.join(codexManaged, "session_index.jsonl"),
      path.join(codexPersonal, "session_index.jsonl"),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(codexPersonal, "session_index.jsonl"), "utf8"),
    '{"id":"X"}\n{"id":"Y"}\n',
  );
  console.log("PASS history.jsonl and session_index.jsonl heal as a lossless line union");
}

async function testRealDirectoryMigration() {
  const personal = path.join(TMP, "claude-migrate", "personal");
  const managed = path.join(TMP, "claude-migrate", "managed");
  fs.mkdirSync(path.join(personal, "projects", "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "projects", "enc", "both.jsonl"), "personal copy\n");
  fs.mkdirSync(path.join(managed, "projects", "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(managed, "projects", "enc", "only-managed.jsonl"), "managed transcript\n");
  fs.writeFileSync(path.join(managed, "projects", "enc", "both.jsonl"), "managed copy\n");

  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "projects"), "merged-dir");
  assert.ok(isLinkTo(path.join(managed, "projects"), path.join(personal, "projects")));
  // The unique transcript moved into the shared store; the collision kept the
  // PERSONAL copy and stashed the managed one.
  assert.equal(
    fs.readFileSync(path.join(personal, "projects", "enc", "only-managed.jsonl"), "utf8"),
    "managed transcript\n",
  );
  assert.equal(
    fs.readFileSync(path.join(personal, "projects", "enc", "both.jsonl"), "utf8"),
    "personal copy\n",
  );
  const stashRoots = stashRootsIn(managed);
  assert.equal(stashRoots.length, 1, "colliding managed entries must be stashed");
  assert.equal(
    fs.readFileSync(path.join(managed, stashRoots[0], "projects", "enc", "both.jsonl"), "utf8"),
    "managed copy\n",
  );
  // The staged migration directory is cleaned up after a full merge.
  assert.deepEqual(
    fs.readdirSync(managed).filter((name) => name.includes(".migrating-")),
    [],
  );
  console.log("PASS a real projects/ directory migrates: transcripts merge, collisions keep personal and stash managed");
}

async function testInterruptedMigrationRecovery() {
  // A crash inside migrateRealDirectory leaves the link installed and the
  // unmerged remainder in a `.projects.migrating-*` stage. The next heal must
  // finish the merge instead of declaring the (correct) link done.
  const personal = path.join(TMP, "claude-recover", "personal");
  const managed = path.join(TMP, "claude-recover", "managed");
  fs.mkdirSync(path.join(personal, "projects"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(personal, "projects"), path.join(managed, "projects"));
  const stage = path.join(managed, ".projects.migrating-deadbeef");
  fs.mkdirSync(path.join(stage, "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, "enc", "stranded.jsonl"), "stranded transcript\n");

  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "claude" });
  assert.equal(outcomeOf(result, "projects"), "linked");
  assert.equal(
    fs.readFileSync(path.join(personal, "projects", "enc", "stranded.jsonl"), "utf8"),
    "stranded transcript\n",
    "an interrupted migration's transcripts must reach the shared store",
  );
  assert.equal(fs.existsSync(stage), false, "the recovered stage must be cleaned up");
  console.log("PASS an interrupted migration stage is recovered on the next heal");
}

async function testCodexFreshAndDeepMerge() {
  const personal = path.join(TMP, "codex", "personal");
  const managed = path.join(TMP, "codex", "managed");
  fs.mkdirSync(personal, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(personal, "config.toml"), 'model = "personal"\n', { mode: 0o600 });
  fs.writeFileSync(path.join(personal, "auth.json"), "PERSONAL_CODEX_CREDENTIAL", { mode: 0o600 });
  fs.mkdirSync(path.join(personal, "sessions", "2026", "08", "04"), { recursive: true });
  fs.writeFileSync(
    path.join(personal, "sessions", "2026", "08", "04", "rollout-personal.jsonl"),
    "personal rollout\n",
  );
  fs.writeFileSync(path.join(managed, "auth.json"), "MANAGED_CODEX_CREDENTIAL", { mode: 0o600 });
  // Pre-feature managed sessions nest by DATE: the merge must recurse past
  // one level or a whole month of transcripts would be stashed on collision.
  fs.mkdirSync(path.join(managed, "sessions", "2026", "08", "04"), { recursive: true });
  fs.writeFileSync(
    path.join(managed, "sessions", "2026", "08", "04", "rollout-managed.jsonl"),
    "managed rollout\n",
  );
  // SQLite artifacts inside a shared dir must never land on the personal
  // side — the database itself included, not just its journals.
  fs.mkdirSync(path.join(managed, "memories"), { recursive: true });
  fs.writeFileSync(path.join(managed, "memories", "note.md"), "managed memory\n");
  fs.writeFileSync(path.join(managed, "memories", "db.sqlite"), "DATABASE");
  fs.writeFileSync(path.join(managed, "memories", "db.sqlite-wal"), "JOURNAL");
  fs.writeFileSync(path.join(managed, "memories", "db.sqlite-shm"), "JOURNAL");

  const result = await shared.ensureSharedCliState({ managedDir: managed, personalDir: personal, runtime: "codex" });
  assert.equal(outcomeOf(result, "sessions"), "merged-dir");
  assert.ok(isLinkTo(path.join(managed, "sessions"), path.join(personal, "sessions")));
  assert.ok(isLinkTo(path.join(managed, "config.toml"), path.join(personal, "config.toml")));
  for (const name of ["archived_sessions", "prompts", "skills", "plugins", "generated_images", "visualizations"]) {
    assert.ok(isLinkTo(path.join(managed, name), path.join(personal, name)), `${name} must be a link`);
  }
  assert.equal(outcomeOf(result, "session_index.jsonl"), "skipped-missing");
  const day = path.join(personal, "sessions", "2026", "08", "04");
  assert.deepEqual(fs.readdirSync(day).sort(), ["rollout-managed.jsonl", "rollout-personal.jsonl"]);
  // The memories DIRECTORY is shared, its regular content merged, but the
  // SQLite artifacts were stashed on the managed side, never moved over.
  assert.ok(isLinkTo(path.join(managed, "memories"), path.join(personal, "memories")));
  assert.equal(fs.readFileSync(path.join(personal, "memories", "note.md"), "utf8"), "managed memory\n");
  for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    assert.equal(fs.existsSync(path.join(personal, "memories", name)), false);
  }
  const stashRoots = stashRootsIn(managed);
  for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    assert.ok(
      stashRoots.some((root) =>
        fs.existsSync(path.join(managed, root, "memories", name)),
      ),
      `${name} must be stashed, not merged`,
    );
  }
  // Credentials never move, never link, never leak across the boundary.
  assert.equal(fs.readFileSync(path.join(managed, "auth.json"), "utf8"), "MANAGED_CODEX_CREDENTIAL");
  assert.equal(fs.lstatSync(path.join(managed, "auth.json")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(personal, "auth.json"), "utf8"), "PERSONAL_CODEX_CREDENTIAL");
  console.log("PASS codex managed home links its share set, deep-merges date-nested sessions, and quarantines sqlite journals");
}

async function testGuards() {
  const dir = path.join(TMP, "guards", "same");
  fs.mkdirSync(dir, { recursive: true });
  const same = await shared.ensureSharedCliState({ managedDir: dir, personalDir: dir, runtime: "claude" });
  assert.equal(same.skipped, "unsafe-input");
  assert.deepEqual(fs.readdirSync(dir), []);

  // win32 keeps the old fully-isolated behavior: the pass is a recorded no-op.
  const personal = path.join(TMP, "guards", "personal");
  const managed = path.join(TMP, "guards", "managed");
  fs.mkdirSync(personal, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(personal, "settings.json"), "{}");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const skipped = await shared.ensureSharedCliState({
      managedDir: managed,
      personalDir: personal,
      runtime: "claude",
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
  const leased = new Set();
  let idIndex = 0;
  const store = new claudeStores.ClaudeCliAccountProfileStore(storeRoot, {
    personalConfigDir: personal,
    personalConfigDirEnv: null,
    idFactory: () => IDS[idIndex++],
    authChecker: () => ({ connected: true }),
    leases: { isLeased: (profileId) => leased.has(profileId) },
  });

  const created = await store.createProfile({ label: "Shared state" });
  const configDir = claudeStores.claudeCliManagedProfileConfigDir(storeRoot, created.profile.id);
  assert.ok(isLinkTo(path.join(configDir, "projects"), path.join(personal, "projects")));
  assert.ok(isLinkTo(path.join(configDir, "settings.json"), path.join(personal, "settings.json")));

  // Simulate a pre-feature profile that is currently LEASED: the heal must
  // skip entirely (the state was healed when the first terminal resolved).
  fs.rmSync(path.join(configDir, "projects"));
  fs.mkdirSync(path.join(configDir, "projects", "enc"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, "projects", "enc", "live.jsonl"), "live transcript\n");
  leased.add(created.profile.id);
  await store.resolveProfile({ profileId: created.profile.id });
  assert.equal(
    fs.lstatSync(path.join(configDir, "projects")).isSymbolicLink(),
    false,
    "a leased profile must not be healed",
  );
  assert.equal(fs.readFileSync(path.join(configDir, "projects", "enc", "live.jsonl"), "utf8"), "live transcript\n");

  // Unleased again: the same resolution path migrates the real directory.
  leased.delete(created.profile.id);
  await store.resolveProfile({ profileId: created.profile.id });
  assert.ok(isLinkTo(path.join(configDir, "projects"), path.join(personal, "projects")));
  assert.equal(
    fs.readFileSync(path.join(personal, "projects", "enc", "live.jsonl"), "utf8"),
    "live transcript\n",
  );

  // Deleting a healed profile removes only the links: every personal target
  // survives, transcripts included.
  const doomed = await store.createProfile({ label: "Doomed" });
  const doomedDir = claudeStores.claudeCliManagedProfileConfigDir(storeRoot, doomed.profile.id);
  assert.ok(isLinkTo(path.join(doomedDir, "projects"), path.join(personal, "projects")));
  const deleted = await store.deleteProfile(doomed.profile.id);
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(doomedDir), false);
  assert.equal(
    fs.readFileSync(path.join(personal, "projects", "enc", "live.jsonl"), "utf8"),
    "live transcript\n",
  );
  assert.equal(fs.readFileSync(path.join(personal, "settings.json"), "utf8"), '{"theme":"dark"}');
  console.log("PASS store wiring: create links, resolve heals, leased skips, deletion spares personal state");
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
  await testClaudeFreshLinkSet();
  await testClobberHealing();
  await testJsonlLineUnion();
  await testRealDirectoryMigration();
  await testInterruptedMigrationRecovery();
  await testCodexFreshAndDeepMerge();
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
