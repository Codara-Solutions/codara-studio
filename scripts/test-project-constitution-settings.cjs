#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-constitution-settings-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "constitution-settings-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(entry) {
  const outfile = path.join(TMP, "project-constitution-settings.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function makeWorkspace(name, cwd = path.join(TMP, name)) {
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id: `workspace-${name}`,
    name,
    cwd,
    color: "#123456",
    workers: [],
  };
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
}

async function main() {
  const settings = await bundle(
    path.join(ROOT, "src", "main", "project-constitution-settings.ts"),
  );

  const fresh = makeWorkspace("fresh");
  const missing = await settings.inspectProjectConstitution(fresh);
  assert.equal(missing.status, "missing");
  assert.equal(missing.sourcePath, ".codara/constitution.md");
  assert.equal(missing.canCreate, true);
  assert.equal("text" in missing, false, "inspection must never return file contents");

  const active = await settings.createDefaultProjectConstitution(fresh);
  const target = path.join(fresh.cwd, ".codara", "constitution.md");
  assert.equal(active.status, "active");
  assert.match(active.shortHash, /^[a-f0-9]{12}$/);
  assert.equal("sha256" in active, false, "Settings projection must not return the full hash");
  assert.equal(active.canOpen, true);
  assert.match(active.detail, /Cora run or Studio-launched Claude\/Codex pane starts/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp")),
    false,
    "exclusive publication must clean temporary files",
  );

  const template = fs.readFileSync(target, "utf8");
  for (const phrase of [
    "Evidence over assertion",
    "Model lanes",
    "Dispatch discipline",
    "Cleanup ritual",
    "Prefer Claude for architecture, pure UI, and exploratory decomposition",
    "Prefer Codex for surgical edits, mechanical changes, state machines, and deterministic work",
    "cross-provider verifier",
    "do not impose quotas or forced alternation",
    "cannot broaden",
    "AGENTS.md",
    "CLAUDE.md",
    "Claude and Codex panes launched from Codara Studio",
    "exact task-owned temporary paths",
    "Never use broad git clean",
  ]) {
    assert.ok(template.includes(phrase), `default template must include ${phrase}`);
  }

  const custom = "# User-owned constitution\n";
  fs.writeFileSync(target, custom);
  await rejectsWith(
    () => settings.createDefaultProjectConstitution(fresh),
    /already exists.*did not overwrite/i,
  );
  assert.equal(fs.readFileSync(target, "utf8"), custom);

  const concurrent = makeWorkspace("concurrent");
  const concurrentResults = await Promise.allSettled([
    settings.createDefaultProjectConstitution(concurrent),
    settings.createDefaultProjectConstitution(concurrent),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.status === "fulfilled").length,
    1,
    "exactly one concurrent exclusive creator must win",
  );
  const concurrentFailure = concurrentResults.find((result) => result.status === "rejected");
  assert.ok(concurrentFailure, "the losing concurrent create must reject");
  assert.match(concurrentFailure.reason.message, /already exists.*did not overwrite/i);
  const concurrentTarget = path.join(concurrent.cwd, ".codara", "constitution.md");
  assert.equal(
    fs.readFileSync(concurrentTarget, "utf8"),
    settings.DEFAULT_PROJECT_CONSTITUTION_TEMPLATE,
    "the winning concurrent creator must publish the complete template",
  );
  assert.equal(
    fs.readdirSync(path.dirname(concurrentTarget)).some((name) => name.endsWith(".tmp")),
    false,
    "a concurrent create race must leave no temporary files",
  );

  const invalid = makeWorkspace("invalid");
  fs.mkdirSync(path.join(invalid.cwd, ".codara"));
  fs.writeFileSync(path.join(invalid.cwd, ".codara", "constitution.md"), "bad\u0000text");
  const invalidResult = await settings.inspectProjectConstitution(invalid);
  assert.equal(invalidResult.status, "invalid-or-unsupported");
  assert.equal(invalidResult.canCreate, false);

  const outside = path.join(TMP, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "constitution.md"), "# outside");
  const linkedDirectory = makeWorkspace("linked-directory");
  fs.symlinkSync(outside, path.join(linkedDirectory.cwd, ".codara"));
  const linkedDirectoryResult = await settings.inspectProjectConstitution(linkedDirectory);
  assert.equal(linkedDirectoryResult.status, "invalid-or-unsupported");
  assert.match(linkedDirectoryResult.detail, /symlink/i);
  await rejectsWith(
    () => settings.createDefaultProjectConstitution(linkedDirectory),
    /symlink/i,
  );

  const linkedFile = makeWorkspace("linked-file");
  fs.mkdirSync(path.join(linkedFile.cwd, ".codara"));
  fs.symlinkSync(
    path.join(outside, "constitution.md"),
    path.join(linkedFile.cwd, ".codara", "constitution.md"),
  );
  const linkedFileResult = await settings.inspectProjectConstitution(linkedFile);
  assert.equal(linkedFileResult.status, "invalid-or-unsupported");
  assert.match(linkedFileResult.detail, /symlink/i);
  await rejectsWith(
    () => settings.createDefaultProjectConstitution(linkedFile),
    /already exists.*did not overwrite/i,
  );

  const remote = {
    ...makeWorkspace("remote-placeholder"),
    cwd: "ssh://host/project",
    remote: { hostId: "host" },
  };
  const remoteResult = await settings.inspectProjectConstitution(remote);
  assert.equal(remoteResult.status, "invalid-or-unsupported");
  assert.match(remoteResult.detail, /only for local workspaces/i);
  await rejectsWith(
    () => settings.createDefaultProjectConstitution(remote),
    /only for local workspaces/i,
  );

  const ipc = read("src/main/ipc.ts");
  const preload = read("src/preload/index.ts");
  const shared = read("src/shared/types.ts");
  const ui = read("src/renderer/src/components/SettingsDialog.tsx");
  const app = read("src/renderer/src/App.tsx");
  const implementation = read("src/main/project-constitution-settings.ts");

  for (const channel of ["inspect", "create", "open", "reveal"]) {
    assert.ok(
      ipc.includes(`handle(\\n    "project-constitution:${channel}"`.replace("\\n", "\n")),
      `${channel} must use trusted handle()`,
    );
    assert.ok(preload.includes(`ipcRenderer.invoke("project-constitution:${channel}", input)`));
  }
  assert.match(ipc, /const state = await loadState\(\)/);
  assert.match(
    ipc,
    /state\.workspaces\.find\(\(candidate\) => candidate\.id === workspaceId\)/,
  );
  assert.doesNotMatch(
    shared.slice(
      shared.indexOf("export interface ProjectConstitutionWorkspaceInput"),
      shared.indexOf("export interface RunState"),
    ),
    /\bcwd\b|\bpath\b/i,
    "renderer input must contain a workspace id only",
  );
  assert.match(implementation, /fs\.link\(temporaryPath, sourcePath\)/);
  assert.match(implementation, /fsConstants\.O_EXCL/);
  assert.match(implementation, /fs\.mkdir\(directoryPath, \{ mode: 0o700 \}\)/);
  assert.match(implementation, /isSymbolicLink\(\)/);
  assert.doesNotMatch(implementation, /node:child_process|\bexecFile\b|\bspawn\b/);

  for (const label of [
    "Project constitution",
    "Missing",
    "Active",
    "Invalid or unsupported",
    "Create default",
    "Open file",
    "Reveal",
    ".codara/constitution.md",
    "Claude and Codex panes launched from Codara Studio",
  ]) {
    assert.ok(ui.includes(label), `Settings UI must expose ${label}`);
  }
  assert.match(ui, /inspection\.shortHash/);
  assert.match(app, /workspaceId=\{activeWorkspace\?\.id \?\? null\}/);
  assert.doesNotMatch(
    implementation,
    /homedir|sparkHome|CLAUDE_CONFIG_DIR|CODEX_HOME/,
    "phase 2 must remain project-local",
  );

  console.log("PASS project constitution Settings security, lifecycle, and UI contract");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
