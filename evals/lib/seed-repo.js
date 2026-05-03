// Helper: prepare a fresh working tree at a known seed commit so each
// adapter run starts from byte-identical state.
//
// We do NOT use `git worktree` because it would litter the user's main repo
// with extra worktree refs and is also harder to clean up across runs. We
// instead clone the source repo to a temp dir with --no-hardlinks and reset
// to the seed commit.
//
// The seed commit is recorded in `evals/tasks/<task>/seed.json`. The harness
// updates the seed.json to the current main SHA only when a human explicitly
// re-pins it; the eval is otherwise reproducible against the recorded SHA.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const stderr = res.stderr || "";
    const stdout = res.stdout || "";
    throw new Error(
      `Command failed (${cmd} ${args.join(" ")}) in ${cwd || process.cwd()}: ${stderr || stdout}`,
    );
  }
  return res.stdout || "";
}

/**
 * Resolve the absolute path of the source repo (the one containing the
 * `evals/` folder). We walk up from this file until we find a `.git` dir.
 */
function findSourceRepo() {
  let cur = path.resolve(__dirname);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`Could not locate source repo (no .git found above ${__dirname}).`);
}

function readSeed(taskDir) {
  const seedPath = path.join(taskDir, "seed.json");
  const raw = fs.readFileSync(seedPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.seedCommit || typeof parsed.seedCommit !== "string") {
    throw new Error(`seed.json at ${seedPath} is missing seedCommit.`);
  }
  return parsed;
}

/**
 * Prepare a fresh working tree at the seed commit. Returns the absolute path.
 *
 * @param {Object} opts
 * @param {string} opts.taskDir            absolute path to evals/tasks/<task>
 * @param {string} opts.runId              unique run id (used for the temp dir name)
 * @param {string} [opts.tmpRoot]          parent dir for the temp repo (defaults to os.tmpdir())
 * @param {boolean} [opts.linkNodeModules] when true, mirror node_modules from
 *                                          the source repo into the temp clone
 *                                          so public gates that need installed
 *                                          packages (typecheck, etc.) can run
 *                                          without waiting on `npm ci`. Linked
 *                                          via junction (Windows) / symlink
 *                                          (POSIX) where supported, else copied.
 */
function prepareSeedRepo(opts) {
  const seed = readSeed(opts.taskDir);
  const sourceRepo = findSourceRepo();
  const tmpRoot = opts.tmpRoot || path.join(os.tmpdir(), "spark-eval");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dest = path.join(tmpRoot, `${opts.runId}`);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  // Clone with --no-hardlinks so we can rewrite the working tree without
  // affecting the source repo. -s would share objects but make the temp tree
  // fragile if the source repo gets gc'd mid-run.
  run("git", ["clone", "--no-hardlinks", "--quiet", sourceRepo, dest]);
  // Reset to the recorded seed commit. We use --hard so any later branches
  // present in the cloned tree don't influence the agent.
  run("git", ["checkout", "--quiet", seed.seedCommit], dest);
  run("git", ["reset", "--hard", "--quiet", seed.seedCommit], dest);
  // Detach so the agent's commits don't pollute "main".
  run("git", ["checkout", "--quiet", "--detach"], dest);

  if (opts.linkNodeModules !== false) {
    // Default ON: mirror node_modules so public gates work without npm ci.
    mirrorNodeModules(sourceRepo, dest);
  }

  return { dir: dest, seed };
}

function mirrorNodeModules(sourceRepo, dest) {
  // We look for node_modules in the source repo (the worktree) and, failing
  // that, in the canonical "main" repo one level up — git worktrees often
  // share node_modules with the main checkout.
  const candidates = [
    path.join(sourceRepo, "node_modules"),
    path.join(sourceRepo, "..", "..", "..", "node_modules"),
    path.join(sourceRepo, "..", "..", "node_modules"),
  ];
  let src = null;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      src = path.resolve(c);
      break;
    }
  }
  if (!src) return; // nothing to mirror; gate runner will surface the missing deps
  const target = path.join(dest, "node_modules");
  if (fs.existsSync(target)) return;
  // Prefer a junction/symlink for speed. cpSync of node_modules is a minute+.
  try {
    fs.symlinkSync(src, target, process.platform === "win32" ? "junction" : "dir");
    return;
  } catch {
    /* fall through to copy */
  }
  try {
    fs.cpSync(src, target, { recursive: true, dereference: false });
  } catch {
    /* if even cpSync fails (permissions, etc.), bail silently — the gates
       will report the resulting npm error, which is more actionable than a
       harness exception here. */
  }
}

/**
 * Re-pin a task's seed to the current HEAD of the source repo. Useful when
 * the task fixtures themselves change and you want fresh evals to start from
 * the new tip. Not invoked automatically — callers must opt in.
 */
function repinSeed(taskDir) {
  const sourceRepo = findSourceRepo();
  const sha = run("git", ["rev-parse", "HEAD"], sourceRepo).trim();
  const seedPath = path.join(taskDir, "seed.json");
  const existing = fs.existsSync(seedPath)
    ? JSON.parse(fs.readFileSync(seedPath, "utf8"))
    : {};
  const next = { ...existing, seedCommit: sha, repinnedAt: new Date().toISOString() };
  fs.writeFileSync(seedPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function cleanupSeedRepo(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave it for the OS to clean later */
  }
}

module.exports = {
  findSourceRepo,
  readSeed,
  prepareSeedRepo,
  repinSeed,
  cleanupSeedRepo,
};
