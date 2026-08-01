#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-user-constitution-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "user-constitution-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // The test always supplies an isolated root directly. Keep Electron and
    // the machine's real app-data path out of the bundled behavioral test.
    build.onResolve({ filter: /^\.\/spark-home$/ }, () => ({
      path: "spark-home-test-stub",
      namespace: "user-constitution-test",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "user-constitution-test" },
      () => ({ contents: 'export function sparkHome() { throw new Error("unexpected default store access"); }' }),
    );
  },
};

async function bundleStore() {
  const outfile = path.join(TMP, "user-constitution-store.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "user-constitution-store.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function hash(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

function storePaths(storeModule, root, revision, sha256) {
  const data = path.join(root, storeModule.USER_CONSTITUTION_DATA_DIRECTORY);
  const revisions = path.join(data, storeModule.USER_CONSTITUTION_REVISIONS_DIRECTORY);
  const blobs = path.join(data, storeModule.USER_CONSTITUTION_BLOBS_DIRECTORY);
  return {
    pointer: path.join(root, storeModule.USER_CONSTITUTION_FILE),
    data,
    revisions,
    blobs,
    revision: revision === undefined ? undefined : path.join(revisions, `${revision}.json`),
    blob: sha256 === undefined ? undefined : path.join(blobs, `${sha256}.txt`),
  };
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function writeJson(target, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function assertMode(target, expected) {
  if (process.platform === "win32") return;
  assert.equal(fs.statSync(target).mode & 0o777, expected, `${target} mode`);
}

async function rejectsWith(action, pattern) {
  let error = null;
  try {
    await action();
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof Error, "expected operation to reject");
  assert.match(error.message, pattern);
  return error;
}

async function main() {
  const storeModule = await bundleStore();

  // Fresh Settings API remains unchanged: the built-in body is returned in
  // memory, but nothing is durable until the first save.
  const root = path.join(TMP, "app-data");
  const store = new storeModule.UserConstitutionStore(root);
  const initial = await store.load();
  assert.equal(initial.enabled, false, "the unsaved constitution must be opt-in");
  assert.equal(initial.revision, 0);
  assert.equal(initial.updatedAt, null);
  assert.match(initial.sha256, /^[a-f0-9]{64}$/);
  for (const phrase of [
    "Evidence over assertion",
    "Model lanes",
    "Dispatch discipline",
    "Cleanup ritual",
    "cannot broaden a task",
    "repository-owned instructions remain",
    "cross-provider verification",
    "Never use broad cleanup commands",
  ]) {
    assert.ok(initial.body.includes(phrase), `default constitution must include ${phrase}`);
  }
  assert.deepEqual(await store.captureCurrent(), {
    enabledAtCapture: false,
    revision: 0,
    sha256: initial.sha256,
  });
  await rejectsWith(
    () => store.resolveEnabledCapture(awaitCapture(false, 0, initial.sha256)),
    /disabled/i,
  );

  // First save creates one body-free pointer, one immutable revision, and one
  // content-addressed blob. The load/save document shape still includes body.
  const bodyOne = "# My global agreement\n\n- Verify before reporting.\n";
  const savedOne = await store.save({
    enabled: true,
    body: bodyOne,
    expectedRevision: initial.revision,
  });
  const captureOne = await store.captureCurrent();
  assert.deepEqual(captureOne, {
    enabledAtCapture: true,
    revision: 1,
    sha256: hash(bodyOne),
  });
  assert.equal(savedOne.body, bodyOne);
  assert.equal(await store.resolveEnabledCapture(captureOne), bodyOne);

  let paths = storePaths(storeModule, root, savedOne.revision, savedOne.sha256);
  const pointerOne = readJson(paths.pointer);
  assert.deepEqual(
    Object.keys(pointerOne).sort(),
    ["enabled", "revision", "schemaVersion", "sha256", "updatedAt"].sort(),
  );
  assert.equal(pointerOne.schemaVersion, 2);
  assert.equal(pointerOne.body, undefined, "the current pointer must not duplicate the body");
  assert.equal(fs.readFileSync(paths.blob, "utf8"), bodyOne);
  assert.deepEqual(readJson(paths.revision), {
    schemaVersion: 2,
    enabledAtCapture: true,
    revision: 1,
    sha256: savedOne.sha256,
    updatedAt: savedOne.updatedAt,
  });
  for (const directory of [root, paths.data, paths.revisions, paths.blobs]) {
    assertMode(directory, 0o700);
  }
  for (const file of [paths.pointer, paths.revision, paths.blob]) {
    assertMode(file, 0o600);
  }
  assert.equal(
    fs.readdirSync(root).some((name) => name.endsWith(".tmp")),
    false,
    "atomic save must clean root temporary files",
  );

  // Disable and re-enable are real monotonic revisions, while the same body
  // remains one blob. Old enabled captures continue to resolve exactly.
  const blobMtime = fs.statSync(paths.blob).mtimeMs;
  const disabled = await store.save({
    enabled: false,
    body: bodyOne,
    expectedRevision: savedOne.revision,
  });
  const disabledCapture = await store.captureCurrent();
  assert.deepEqual(disabledCapture, {
    enabledAtCapture: false,
    revision: 2,
    sha256: savedOne.sha256,
  });
  assert.equal(await store.resolveEnabledCapture(captureOne), bodyOne);
  await rejectsWith(() => store.resolveEnabledCapture(disabledCapture), /disabled/i);
  assert.equal(fs.readdirSync(paths.blobs).length, 1, "same body must dedupe by hash");
  assert.equal(fs.statSync(paths.blob).mtimeMs, blobMtime, "dedupe must not rewrite body bytes");

  const reenabled = await store.save({
    enabled: true,
    body: bodyOne,
    expectedRevision: disabled.revision,
  });
  assert.equal(reenabled.revision, 3);
  assert.equal(reenabled.sha256, savedOne.sha256);
  assert.equal(fs.readdirSync(paths.blobs).length, 1);
  assert.equal(fs.readdirSync(paths.revisions).length, 3, "every save keeps immutable provenance");

  const bodyTwo = "# Revised global agreement\n\n- Inspect evidence twice.\n";
  const savedTwo = await store.save({
    enabled: true,
    body: bodyTwo,
    expectedRevision: reenabled.revision,
  });
  const captureTwo = await store.captureCurrent();
  assert.equal(savedTwo.revision, 4);
  assert.equal(fs.readdirSync(paths.blobs).length, 2);
  assert.equal(await store.resolveEnabledCapture(captureOne), bodyOne);
  assert.equal(await store.resolveEnabledCapture(captureTwo), bodyTwo);

  // Independent facades share a root-wide queue. Only one same-base save may
  // advance the durable pointer.
  const concurrentStoreA = new storeModule.UserConstitutionStore(root);
  const concurrentStoreB = new storeModule.UserConstitutionStore(root);
  const concurrent = await Promise.allSettled([
    concurrentStoreA.save({
      enabled: true,
      body: "# Concurrent winner A\n",
      expectedRevision: savedTwo.revision,
    }),
    concurrentStoreB.save({
      enabled: true,
      body: "# Concurrent winner B\n",
      expectedRevision: savedTwo.revision,
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = concurrent.find((result) => result.status === "rejected");
  assert.ok(conflict);
  assert.equal(conflict.reason.code, "USER_CONSTITUTION_REVISION_CONFLICT");
  assert.match(conflict.reason.message, /expected revision 4, current revision 5/i);

  const durableStore = new storeModule.UserConstitutionStore(root);
  const durable = await durableStore.load();
  assert.equal(durable.revision, 5);
  assert.equal(durable.sha256, hash(durable.body));
  assert.equal(
    await durableStore.resolveEnabledCapture(captureOne),
    bodyOne,
    "an old capture must resolve after later edits and process restart",
  );

  // Validation failures never move the pointer.
  const beforeInvalid = fs.readFileSync(paths.pointer);
  for (const [body, pattern] of [
    ["", /cannot be empty/i],
    ["# bad\u0000body", /control character/i],
    ["# bad\u0085body", /control character/i],
    ["# bad \ud800 body", /valid UTF-8/i],
    ["é".repeat(8_193), /16 KiB/i],
  ]) {
    await rejectsWith(
      () => durableStore.save({ enabled: true, body, expectedRevision: durable.revision }),
      pattern,
    );
  }
  assert.deepEqual(fs.readFileSync(paths.pointer), beforeInvalid);
  const whitespace = await durableStore.save({
    enabled: true,
    body: "# Allowed whitespace\n\tindented\r\n",
    expectedRevision: durable.revision,
  });
  assert.equal(whitespace.revision, 6);

  // Schema-1 migration writes and verifies blob + revision before replacing
  // the only body-bearing pointer. Settings still receives the same document.
  const migrationRoot = path.join(TMP, "schema-1-migration");
  fs.mkdirSync(migrationRoot, { mode: 0o755 });
  const legacyBody = "# Legacy body survives migration\n";
  const legacy = {
    schemaVersion: 1,
    enabled: true,
    body: legacyBody,
    revision: 7,
    sha256: hash(legacyBody),
    updatedAt: new Date("2026-01-02T03:04:05.000Z").toISOString(),
  };
  const migrationPaths = storePaths(storeModule, migrationRoot, legacy.revision, legacy.sha256);
  writeJson(migrationPaths.pointer, legacy, 0o644);
  const migratedStore = new storeModule.UserConstitutionStore(migrationRoot);
  const migrated = await migratedStore.load();
  assert.deepEqual(migrated, {
    enabled: legacy.enabled,
    body: legacy.body,
    revision: legacy.revision,
    sha256: legacy.sha256,
    updatedAt: legacy.updatedAt,
  });
  assert.equal(readJson(migrationPaths.pointer).schemaVersion, 2);
  assert.equal(readJson(migrationPaths.pointer).body, undefined);
  assert.equal(fs.readFileSync(migrationPaths.blob, "utf8"), legacyBody);
  assert.equal(readJson(migrationPaths.revision).revision, legacy.revision);
  assert.equal(await migratedStore.resolveEnabledCapture(await migratedStore.captureCurrent()), legacyBody);
  for (const directory of [migrationRoot, migrationPaths.data, migrationPaths.revisions, migrationPaths.blobs]) {
    assertMode(directory, 0o700);
  }
  for (const file of [migrationPaths.pointer, migrationPaths.revision, migrationPaths.blob]) {
    assertMode(file, 0o600);
  }
  assert.deepEqual(
    await new storeModule.UserConstitutionStore(migrationRoot).load(),
    migrated,
    "schema-2 reload after migration must be idempotent",
  );

  const largeMigrationRoot = path.join(TMP, "large-schema-1-migration");
  const largeLegacyBody = `# Large legacy body\n${"a".repeat(15_000)}\n`;
  const largeLegacy = {
    schemaVersion: 1,
    enabled: true,
    body: largeLegacyBody,
    revision: 2,
    sha256: hash(largeLegacyBody),
    updatedAt: new Date("2026-01-03T03:04:05.000Z").toISOString(),
  };
  const largeMigrationPaths = storePaths(
    storeModule,
    largeMigrationRoot,
    largeLegacy.revision,
    largeLegacy.sha256,
  );
  writeJson(largeMigrationPaths.pointer, largeLegacy);
  assert.ok(fs.statSync(largeMigrationPaths.pointer).size > 8 * 1024);
  assert.equal(
    (await new storeModule.UserConstitutionStore(largeMigrationRoot).load()).body,
    largeLegacyBody,
    "schema-1's former 64 KiB envelope must migrate a valid 16 KiB body",
  );

  // Restart during migration: matching immutable prerequisites may already be
  // present while the schema-1 pointer still owns the body. Re-entry verifies
  // and reuses them, then completes the pointer replacement.
  const interruptedMigrationRoot = path.join(TMP, "interrupted-migration");
  const interruptedLegacy = {
    ...legacy,
    body: "# Interrupted migration body\n",
    revision: 4,
    updatedAt: new Date("2026-02-03T04:05:06.000Z").toISOString(),
  };
  interruptedLegacy.sha256 = hash(interruptedLegacy.body);
  const interruptedPaths = storePaths(
    storeModule,
    interruptedMigrationRoot,
    interruptedLegacy.revision,
    interruptedLegacy.sha256,
  );
  fs.mkdirSync(interruptedPaths.revisions, { recursive: true, mode: 0o700 });
  fs.mkdirSync(interruptedPaths.blobs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(interruptedPaths.blob, interruptedLegacy.body, { mode: 0o600 });
  writeJson(interruptedPaths.revision, {
    schemaVersion: 2,
    enabledAtCapture: interruptedLegacy.enabled,
    revision: interruptedLegacy.revision,
    sha256: interruptedLegacy.sha256,
    updatedAt: interruptedLegacy.updatedAt,
  });
  writeJson(interruptedPaths.pointer, interruptedLegacy);
  const interruptedBlobMtime = fs.statSync(interruptedPaths.blob).mtimeMs;
  const resumedMigration = await new storeModule.UserConstitutionStore(interruptedMigrationRoot).load();
  assert.equal(resumedMigration.body, interruptedLegacy.body);
  assert.equal(readJson(interruptedPaths.pointer).schemaVersion, 2);
  assert.equal(fs.statSync(interruptedPaths.blob).mtimeMs, interruptedBlobMtime);

  // A conflicting prerequisite fails closed while the schema-1 pointer still
  // retains the only authoritative body; migration never replaces it first.
  const failedMigrationRoot = path.join(TMP, "failed-migration-prerequisite");
  const failedMigrationPaths = storePaths(
    storeModule,
    failedMigrationRoot,
    legacy.revision,
    legacy.sha256,
  );
  fs.mkdirSync(failedMigrationPaths.blobs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(failedMigrationPaths.blob, "# Corrupt pre-existing blob\n", { mode: 0o600 });
  writeJson(failedMigrationPaths.pointer, legacy);
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(failedMigrationRoot).load(),
    /invalid or corrupted/i,
  );
  assert.deepEqual(readJson(failedMigrationPaths.pointer), legacy);

  // Restart after a normal save durably wrote its blob/revision but before it
  // advanced the pointer. Repeating the same CAS adopts the immutable record's
  // timestamp and completes the pointer without rewriting either prerequisite.
  const interruptedSaveRoot = path.join(TMP, "interrupted-save");
  const interruptedSaveStore = new storeModule.UserConstitutionStore(interruptedSaveRoot);
  const base = await interruptedSaveStore.save({
    enabled: true,
    body: "# Base\n",
    expectedRevision: 0,
  });
  const pendingBody = "# Pending durable revision\n";
  const pendingSha = hash(pendingBody);
  const pendingUpdatedAt = new Date("2026-03-04T05:06:07.000Z").toISOString();
  const pendingPaths = storePaths(storeModule, interruptedSaveRoot, 2, pendingSha);
  fs.writeFileSync(pendingPaths.blob, pendingBody, { mode: 0o600 });
  writeJson(pendingPaths.revision, {
    schemaVersion: 2,
    enabledAtCapture: false,
    revision: 2,
    sha256: pendingSha,
    updatedAt: pendingUpdatedAt,
  });
  const resumedSaveStore = new storeModule.UserConstitutionStore(interruptedSaveRoot);
  const resumedSave = await resumedSaveStore.save({
    enabled: false,
    body: pendingBody,
    expectedRevision: base.revision,
  });
  assert.equal(resumedSave.revision, 2);
  assert.equal(resumedSave.updatedAt, pendingUpdatedAt);
  assert.equal(readJson(pendingPaths.pointer).updatedAt, pendingUpdatedAt);

  await corruptionTests(storeModule, root, captureOne, bodyOne);
  sourceContractTests();

  console.log("PASS schema-2 global user constitution storage, migration, capture, and Settings contract");
}

function awaitCapture(enabledAtCapture, revision, sha256) {
  return { enabledAtCapture, revision, sha256 };
}

async function corruptionTests(storeModule, healthyRoot, healthyCapture, healthyBody) {
  const invalidUtf8Root = path.join(TMP, "invalid-utf8");
  fs.mkdirSync(invalidUtf8Root);
  fs.writeFileSync(
    path.join(invalidUtf8Root, storeModule.USER_CONSTITUTION_FILE),
    Buffer.from([0xc3, 0x28]),
  );
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(invalidUtf8Root).load(),
    /invalid or corrupted/i,
  );

  const oversizedPointerRoot = path.join(TMP, "oversized-pointer");
  fs.mkdirSync(oversizedPointerRoot);
  const oversizedPointer = JSON.stringify({
    schemaVersion: 2,
    enabled: true,
    revision: 1,
    sha256: "0".repeat(64),
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(
    path.join(oversizedPointerRoot, storeModule.USER_CONSTITUTION_FILE),
    `${oversizedPointer}${" ".repeat(8 * 1024 + 1)}`,
  );
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(oversizedPointerRoot).load(),
    /exceeds its size limit/i,
  );

  const nonRegularPointerRoot = path.join(TMP, "non-regular-pointer");
  fs.mkdirSync(path.join(nonRegularPointerRoot, storeModule.USER_CONSTITUTION_FILE), {
    recursive: true,
  });
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(nonRegularPointerRoot).load(),
    /not a regular app-owned file/i,
  );

  const corruptLegacyRoot = path.join(TMP, "corrupt-legacy-hash");
  fs.mkdirSync(corruptLegacyRoot);
  writeJson(path.join(corruptLegacyRoot, storeModule.USER_CONSTITUTION_FILE), {
    schemaVersion: 1,
    enabled: true,
    body: "# altered\n",
    revision: 1,
    sha256: "0".repeat(64),
    updatedAt: new Date().toISOString(),
  });
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(corruptLegacyRoot).load(),
    /invalid or corrupted/i,
  );

  // Exact pair resolution rejects a forged revision/hash combination and
  // never falls back to the current pointer.
  const healthyStore = new storeModule.UserConstitutionStore(healthyRoot);
  await rejectsWith(
    () => healthyStore.resolveEnabledCapture({
      ...healthyCapture,
      sha256: hash("# unrelated\n"),
    }),
    /(invalid or corrupted|ENOENT)/i,
  );
  assert.equal(await healthyStore.resolveEnabledCapture(healthyCapture), healthyBody);

  const corruptBlobRoot = path.join(TMP, "corrupt-blob");
  const corruptBlobStore = new storeModule.UserConstitutionStore(corruptBlobRoot);
  const corruptBlobSaved = await corruptBlobStore.save({
    enabled: true,
    body: "# Original blob\n",
    expectedRevision: 0,
  });
  const corruptBlobPaths = storePaths(
    storeModule,
    corruptBlobRoot,
    corruptBlobSaved.revision,
    corruptBlobSaved.sha256,
  );
  fs.writeFileSync(corruptBlobPaths.blob, "# Mutated blob\n");
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(corruptBlobRoot).load(),
    /invalid or corrupted/i,
  );

  const invalidBlobRoot = path.join(TMP, "invalid-utf8-blob");
  const invalidBlobStore = new storeModule.UserConstitutionStore(invalidBlobRoot);
  const invalidBlobSaved = await invalidBlobStore.save({
    enabled: true,
    body: "# UTF-8 blob\n",
    expectedRevision: 0,
  });
  const invalidBlobPaths = storePaths(
    storeModule,
    invalidBlobRoot,
    invalidBlobSaved.revision,
    invalidBlobSaved.sha256,
  );
  fs.writeFileSync(invalidBlobPaths.blob, Buffer.from([0xc3, 0x28]));
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(invalidBlobRoot).load(),
    /invalid or corrupted/i,
  );

  const oversizedRevisionRoot = path.join(TMP, "oversized-revision");
  const oversizedRevisionStore = new storeModule.UserConstitutionStore(oversizedRevisionRoot);
  const oversizedRevisionSaved = await oversizedRevisionStore.save({
    enabled: true,
    body: "# Oversized revision metadata\n",
    expectedRevision: 0,
  });
  const oversizedRevisionPaths = storePaths(
    storeModule,
    oversizedRevisionRoot,
    oversizedRevisionSaved.revision,
    oversizedRevisionSaved.sha256,
  );
  fs.writeFileSync(oversizedRevisionPaths.revision, "x".repeat(8 * 1024 + 1));
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(oversizedRevisionRoot).load(),
    /exceeds its size limit/i,
  );

  const mismatchRoot = path.join(TMP, "revision-pair-mismatch");
  const mismatchStore = new storeModule.UserConstitutionStore(mismatchRoot);
  const mismatchSaved = await mismatchStore.save({
    enabled: true,
    body: "# Pair\n",
    expectedRevision: 0,
  });
  const mismatchPaths = storePaths(
    storeModule,
    mismatchRoot,
    mismatchSaved.revision,
    mismatchSaved.sha256,
  );
  const mismatchRevision = readJson(mismatchPaths.revision);
  mismatchRevision.enabledAtCapture = false;
  writeJson(mismatchPaths.revision, mismatchRevision);
  await rejectsWith(
    () => new storeModule.UserConstitutionStore(mismatchRoot).load(),
    /invalid or corrupted/i,
  );

  if (process.platform !== "win32") {
    const healthyPaths = storePaths(
      storeModule,
      healthyRoot,
      healthyCapture.revision,
      healthyCapture.sha256,
    );

    const linkedRootTarget = path.join(TMP, "linked-root-target");
    const linkedRoot = path.join(TMP, "linked-root");
    fs.mkdirSync(linkedRootTarget);
    fs.symlinkSync(linkedRootTarget, linkedRoot);
    await rejectsWith(
      () => new storeModule.UserConstitutionStore(linkedRoot).load(),
      /not an app-owned directory/i,
    );

    const linkedPointerRoot = path.join(TMP, "linked-pointer");
    fs.mkdirSync(linkedPointerRoot);
    fs.symlinkSync(
      healthyPaths.pointer,
      path.join(linkedPointerRoot, storeModule.USER_CONSTITUTION_FILE),
    );
    await rejectsWith(
      () => new storeModule.UserConstitutionStore(linkedPointerRoot).load(),
      /not a regular app-owned file/i,
    );

    const linkedDataRoot = path.join(TMP, "linked-data-directory");
    fs.mkdirSync(linkedDataRoot);
    fs.copyFileSync(healthyPaths.pointer, path.join(linkedDataRoot, storeModule.USER_CONSTITUTION_FILE));
    fs.symlinkSync(
      healthyPaths.data,
      path.join(linkedDataRoot, storeModule.USER_CONSTITUTION_DATA_DIRECTORY),
    );
    await rejectsWith(
      () => new storeModule.UserConstitutionStore(linkedDataRoot).load(),
      /not an app-owned directory/i,
    );

    const linkedBlobRoot = path.join(TMP, "linked-blob");
    const linkedBlobStore = new storeModule.UserConstitutionStore(linkedBlobRoot);
    const linkedBlobSaved = await linkedBlobStore.save({
      enabled: true,
      body: "# Linked blob\n",
      expectedRevision: 0,
    });
    const linkedBlobPaths = storePaths(
      storeModule,
      linkedBlobRoot,
      linkedBlobSaved.revision,
      linkedBlobSaved.sha256,
    );
    fs.unlinkSync(linkedBlobPaths.blob);
    fs.symlinkSync(healthyPaths.blob, linkedBlobPaths.blob);
    await rejectsWith(
      () => new storeModule.UserConstitutionStore(linkedBlobRoot).load(),
      /not a regular app-owned file/i,
    );

    const linkedRevisionRoot = path.join(TMP, "linked-revision");
    const linkedRevisionStore = new storeModule.UserConstitutionStore(linkedRevisionRoot);
    const linkedRevisionSaved = await linkedRevisionStore.save({
      enabled: true,
      body: "# Linked revision\n",
      expectedRevision: 0,
    });
    const linkedRevisionPaths = storePaths(
      storeModule,
      linkedRevisionRoot,
      linkedRevisionSaved.revision,
      linkedRevisionSaved.sha256,
    );
    fs.unlinkSync(linkedRevisionPaths.revision);
    fs.symlinkSync(healthyPaths.revision, linkedRevisionPaths.revision);
    await rejectsWith(
      () => new storeModule.UserConstitutionStore(linkedRevisionRoot).load(),
      /not a regular app-owned file/i,
    );
  }
}

function sourceContractTests() {
  const implementation = source("src/main/user-constitution-store.ts");
  const ipc = source("src/main/ipc.ts");
  const preload = source("src/preload/index.ts");
  const shared = source("src/shared/types.ts");
  const settings = source("src/renderer/src/components/SettingsDialog.tsx");

  assert.match(implementation, /USER_CONSTITUTION_SCHEMA_VERSION = 2/);
  assert.match(implementation, /writeFileAtomic\([\s\S]*mode: PRIVATE_FILE_MODE/);
  assert.match(implementation, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(implementation, /DISALLOWED_CONTROLS/);
  assert.match(implementation, /USER_CONSTITUTION_MAX_BYTES/);
  assert.match(implementation, /createHash\("sha256"\)/);
  assert.match(implementation, /captureCurrentUserConstitution/);
  assert.match(implementation, /resolveEnabledUserConstitutionCapture/);
  assert.doesNotMatch(implementation, /PROJECT_CONSTITUTION|\.codara\/constitution|workspaceId|\bcwd\b/);
  assert.doesNotMatch(
    implementation,
    /process\.env|\bargv\b|console\.|logMain|node:child_process|\bspawn\b|\bexecFile\b/,
    "the app-owned body store must not reach process launch or logging surfaces",
  );

  assert.ok(ipc.includes('handle("user-constitution:load"'));
  assert.ok(ipc.includes('"user-constitution:save"'));
  assert.ok(preload.includes('ipcRenderer.invoke("user-constitution:load")'));
  assert.ok(preload.includes('ipcRenderer.invoke("user-constitution:save", input)'));
  assert.ok(shared.includes("export interface UserConstitutionDocument"));
  assert.ok(shared.includes("export interface UserConstitutionCapture"));
  assert.ok(shared.includes("enabledAtCapture: boolean"));
  assert.ok(shared.includes("export interface UserConstitutionSaveInput"));
  assert.ok(shared.includes("expectedRevision: number"));

  for (const label of [
    "Global user constitution",
    "Enable for supported managed-agent launches",
    "Global user constitution body",
    "Save constitution",
    "Reload stored",
    "UTF-8 bytes",
    "revision",
    "sha256",
    "remains separate from every workspace and project constitution",
  ]) {
    assert.ok(settings.includes(label), `Settings UI must expose ${label}`);
  }
  assert.match(settings, /expectedRevision: document\.revision/);
  assert.match(settings, /data-user-constitution-status/);
  assert.match(settings, /<textarea/);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
