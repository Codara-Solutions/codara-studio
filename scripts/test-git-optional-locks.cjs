#!/usr/bin/env node
"use strict";

// Every git child Codara starts on a user's repository carries
// GIT_OPTIONAL_LOCKS=0, including the spawns that bypass runGit because they
// need stdin or a private index: the result manifest, checkpoints, `git apply`
// for hunk staging and sandbox merge-back, and the worker filesystem diff. A
// status read without it takes the index lock a stash or stage the user
// started at the same moment needs.
//
// A `git` shim first on PATH records the variable for each call and then runs
// the real git. A structural pass then checks that no other direct git spawn
// under src/main was added without the shared environment.
//
//   node scripts/test-git-optional-locks.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function load(entry, stubs = {}) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "fakes",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in stubs ? { path: args.path, namespace: "fakes" } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "fakes" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function realGit(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  realGit(repo, "init", "-q");
  realGit(repo, "config", "user.name", "Codara Test");
  realGit(repo, "config", "user.email", "codara@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  realGit(repo, "add", "a.txt");
  realGit(repo, "commit", "-qm", "base");
  return repo;
}

function structuralCheck() {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        if (rel === "src/main/git-exec.ts" || rel.startsWith("src/main/remote/")) continue;
        const text = fs.readFileSync(full, "utf8");
        const spawnGit = /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*"git"\s*,/g;
        let match;
        while ((match = spawnGit.exec(text))) {
          const call = text.slice(match.index, match.index + 600);
          if (!/gitChildEnv\(|GIT_OPTIONAL_LOCKS/.test(call)) {
            offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
          }
        }
      }
    }
  };
  walk(path.join(ROOT, "src", "main"));
  assert.deepEqual(offenders, [], "direct git spawns without GIT_OPTIONAL_LOCKS=0");
  console.log("  PASS no direct git spawn under src/main skips the shared git environment");
}

async function main() {
  structuralCheck();
  if (process.platform === "win32") {
    console.log("  SKIP the PATH shim needs a POSIX shell");
    console.log("git-optional-locks: 1 check passed");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-git-optional-locks-"));
  const savedPath = process.env.PATH;
  const savedLocks = process.env.GIT_OPTIONAL_LOCKS;
  try {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shimDir = path.join(root, "shim");
    const log = path.join(root, "git-calls.log");
    fs.mkdirSync(shimDir);
    fs.writeFileSync(
      path.join(shimDir, "git"),
      [
        "#!/bin/sh",
        `{ printf '%s ' "\${GIT_OPTIONAL_LOCKS:-unset}"; printf '%s' "$*" | tr '\\n' ' '; echo; } >> '${log}'`,
        `exec '${real}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    delete process.env.GIT_OPTIONAL_LOCKS;
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;

    const calls = () => {
      const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
      fs.rmSync(log, { force: true });
      return lines;
    };
    const expectAllUnlocked = (label, lines) => {
      assert.ok(lines.length > 0, `${label} ran no git`);
      const locked = lines.filter((line) => !line.startsWith("0 "));
      assert.deepEqual(locked, [], `${label} ran git without GIT_OPTIONAL_LOCKS=0`);
      console.log(`  PASS ${label} (${lines.length} git ${lines.length === 1 ? "call" : "calls"})`);
    };

    const repo = makeRepo(root, "repo");
    const baseline = realGit(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    calls();

    const manifest = await load(path.join(ROOT, "src", "main", "orchestration", "result-manifest.ts"));
    await manifest.collectRunResultManifest(
      {
        id: "run-locks",
        title: "locks",
        status: "complete",
        settingsSnapshot: { workspaceCwd: repo },
        checkpoints: [{ kind: "run-start", sha: baseline }],
        workerTasks: [],
        workerAttempts: [],
      },
      () => {
        throw new Error("unexpected path fallback");
      },
    );
    expectAllUnlocked("the result manifest's rev-parse, diff and status", calls());

    const checkpoints = await load(path.join(ROOT, "src", "main", "orchestration", "checkpoints.ts"));
    await checkpoints.createCheckpoint({
      runId: "run-locks",
      cwd: repo,
      kind: "run-start",
      messagePointer: 0,
      label: "start",
    });
    expectAllUnlocked("a checkpoint snapshot", calls());

    const gitApply = await load(path.join(ROOT, "src", "main", "git-apply.ts"), {
      "./git-ops": "export const invalidateGitCache = () => {};",
      "./remote/remote-git": "export const runRemoteGit = async () => { throw new Error('remote'); };",
    });
    const patch = realGit(repo, "diff", "--", "a.txt") + "\n";
    calls();
    const staged = await gitApply.applyPatch(repo, patch, { cached: true, reverse: false });
    assert.equal(staged.ok, true, staged.error);
    expectAllUnlocked("staging a hunk with git apply", calls());

    const worktrees = await load(path.join(ROOT, "src", "main", "git-worktrees.ts"), {
      "./remote/remote-git": "export const runRemoteGit = async () => { throw new Error('remote'); };",
    });
    const base = makeRepo(root, "base");
    const sandbox = path.join(root, "sandbox");
    realGit(base, "worktree", "add", "-q", "--detach", sandbox);
    fs.writeFileSync(path.join(sandbox, "a.txt"), "from sandbox\n");
    calls();
    const merged = await worktrees.mergeBackSandboxWorktree({ repoCwd: base, worktreePath: sandbox });
    assert.equal(merged.ok, true, merged.error);
    assert.equal(fs.readFileSync(path.join(base, "a.txt"), "utf8"), "from sandbox\n");
    expectAllUnlocked("merging a sandbox worktree back", calls());

    const workerDiff = await load(path.join(ROOT, "src", "main", "orchestration", "worker-diff.ts"), {
      "../git-exec": "export const runGit = async () => { throw new Error('unused'); };",
    });
    const plain = path.join(root, "plain");
    const baselineDir = path.join(root, "baseline");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "f.txt"), "before\n");
    assert.equal(
      await workerDiff.captureWorkerFilesystemBaseline({ cwd: plain, paths: ["f.txt"], destination: baselineDir }),
      true,
    );
    fs.writeFileSync(path.join(plain, "f.txt"), "after\n");
    calls();
    const diff = await workerDiff.captureWorkerFilesystemDiff({ cwd: plain, paths: ["f.txt"], baselineDir });
    assert.ok(diff, "filesystem diff captured");
    expectAllUnlocked("the worker filesystem diff", calls());

    console.log("git-optional-locks: 6 checks passed");
  } finally {
    process.env.PATH = savedPath;
    if (savedLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = savedLocks;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
