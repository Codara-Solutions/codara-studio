// A state file storage cannot read starts the app empty. That empty state has
// no rows, yet rows may exist, so Create copy must not take it for "no rows":
// it would hand out a folder a row still names. Driven through the real
// storage module and a real repository.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-unreadable-state-")));
  const home = path.join(tempRoot, "home");
  const repo = path.join(tempRoot, "repo");
  const worktreesRoot = path.join(tempRoot, "worktrees");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  const outfile = path.join(cacheDir, `storage-unreadable-state-${process.pid}.cjs`);
  const previousHome = process.env.CODARA_HOME_DIR;
  const previousSkipMigration = process.env.SPARK_SKIP_LEGACY_MIGRATION;
  const originalConsoleError = console.error;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(home);
  // A row naming a folder that is gone, in a file storage cannot parse.
  const stale = path.join(worktreesRoot, "task");
  fs.writeFileSync(path.join(home, "spark-state.json"), `{"workspaces":[{"id":"ws-stale","cwd":${JSON.stringify(stale)}`);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  process.env.CODARA_HOME_DIR = home;
  process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";
  console.error = () => undefined;
  try {
    await esbuild.build({
      stdin: {
        contents: [
          'export { loadState, saveState } from "./src/main/storage";',
          'export { createRailWorktree } from "./src/main/git-worktrees";',
        ].join("\n"),
        resolveDir: ROOT,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      external: ["electron", "ssh2"],
      logLevel: "silent",
    });
    delete require.cache[outfile];
    const { loadState, saveState, createRailWorktree } = require(outfile);

    const unread = await loadState();
    assert.deepEqual(unread.workspaces, [], "storage starts empty");
    const refused = await createRailWorktree({ repoCwd: repo, worktreesRoot, newBranch: "task" }, loadState);
    assert.equal(refused.ok, false, "nothing is made from a state storage could not read");
    assert.match(refused.error, /could not read its workspaces/);
    assert.equal(fs.existsSync(stale), false, "the row's folder is not handed out");
    assert.throws(() => git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/task"]), "no branch is made");

    // Once a save replaces the state, the rows are known again.
    await saveState({
      workspaces: [{ id: "ws-stale", name: "stale", cwd: stale, color: "#2AA298", workers: [] }],
      workspaceGroups: [],
      workspaceRailOrder: ["ws-stale"],
      activeWorkspaceId: "ws-stale",
    });
    const made = await createRailWorktree({ repoCwd: repo, worktreesRoot, newBranch: "task" }, loadState);
    assert.equal(made.ok, true, made.ok ? "" : made.error);
    assert.equal(path.basename(made.path), "task-2", "the folder the row names is skipped");
    console.log("PASS an unreadable state file stops Create copy; a saved one reserves its rows' folders");
  } finally {
    console.error = originalConsoleError;
    if (previousHome === undefined) delete process.env.CODARA_HOME_DIR;
    else process.env.CODARA_HOME_DIR = previousHome;
    if (previousSkipMigration === undefined) delete process.env.SPARK_SKIP_LEGACY_MIGRATION;
    else process.env.SPARK_SKIP_LEGACY_MIGRATION = previousSkipMigration;
    fs.rmSync(outfile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
