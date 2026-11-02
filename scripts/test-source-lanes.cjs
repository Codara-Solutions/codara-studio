// test-runner: heavy (peaks near 300 MB)
"use strict";
// Source Control's agent lanes: the pure model (src/shared/source-lanes.ts)
// that orders lanes and names each one's next step, and the per-checkout read
// (src/main/git-lanes.ts) against throwaway repositories: commits and
// uncommitted work both count, commits the base gained after the branch left
// do not, untracked files count their lines without following a link, a
// folder that is gone reports its own error, and a repeated read is cached.
//
//   node scripts/test-source-lanes.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./main/git-lanes";
        export * from "./shared/source-lanes";
      `,
      resolveDir: path.join(ROOT, "src"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    external: ["ssh2", "cpu-features"],
    // Nothing here needs Electron; a stub keeps its binary from being fetched.
    plugins: [{
      name: "no-electron",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
      },
    }],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function lane(fields) {
  return {
    id: fields.branch ?? "x",
    workspaceId: fields.branch ?? "x",
    path: `/tmp/${fields.branch ?? "x"}`,
    branch: "b",
    own: false,
    agents: [],
    pullRequest: null,
    merged: false,
    missing: false,
    changes: null,
    ...fields,
  };
}
const agent = (state, since = 1) => ({ key: `pane:${state}`, workspaceId: "w", name: "Claude Code", state, text: null, fromNote: false, since, target: null });
const pr = (checks, phase = "open") => ({ workspaceId: "w", repository: "acme/widgets", number: 7, url: "", title: "t", phase, checks, failed: [], headOid: "abc" });

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

(async () => {
  const api = await load();

  // Next steps
  assert.deepEqual(api.buildSourceLanes([lane({ own: true, agents: [agent("needs-you")] })]).own.steps, [], "the own lane's detail is inline");
  const steps = (fields) => api.buildSourceLanes([lane(fields)]).others[0].steps;
  assert.deepEqual(steps({ agents: [agent("needs-you")], pullRequest: pr("failing") }), ["open-agent", "fix-checks", "open"]);
  assert.deepEqual(steps({ pullRequest: pr("passing") }), ["merge", "open"]);
  assert.deepEqual(steps({ pullRequest: pr("none") }), ["merge", "open"]);
  assert.deepEqual(steps({ pullRequest: pr("pending") }), ["open"], "running checks can still fail");
  assert.deepEqual(steps({ pullRequest: pr("passing", "draft") }), ["open"], "a draft is not asking to land");
  assert.deepEqual(steps({ pullRequest: pr("passing"), agents: [agent("working")] }), ["open-agent", "open"], "an agent still working may push again");
  assert.deepEqual(steps({ pullRequest: pr("passing"), agents: [agent("done")] }), ["merge", "open-agent", "open"]);
  assert.deepEqual(steps({ missing: true }), [], "nothing to open when the folder is gone");

  // Order and grouping
  const built = api.buildSourceLanes([
    lane({ id: "own", own: true }),
    lane({ id: "quiet", branch: "a" }),
    lane({ id: "working", agents: [agent("working")] }),
    lane({ id: "ready", pullRequest: pr("passing") }),
    lane({ id: "failing", pullRequest: pr("failing") }),
    lane({ id: "asks", agents: [agent("needs-you")] }),
    lane({ id: "gone", merged: true }),
  ]);
  assert.deepEqual(built.others.map((item) => item.id), ["asks", "failing", "ready", "working", "quiet"]);
  assert.equal(built.own.id, "own");
  assert.deepEqual(built.merged.map((item) => item.id), ["gone"]);
  assert.equal(api.buildSourceLanes([]).own, null);

  // Real checkouts
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-source-lanes-")));
  try {
    // A fake git config: nothing here reads the user's own.
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.invalid\n");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    fs.writeFileSync(path.join(repo, "app.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(repo, "old.txt"), "gone\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "initial");
    const tree = path.join(root, "tree");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", tree);

    fs.writeFileSync(path.join(tree, "app.txt"), "one\ntwo\nthree\nfour\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "committed work");
    fs.rmSync(path.join(tree, "old.txt"));
    fs.writeFileSync(path.join(tree, "new file.txt"), "a\nb");
    fs.writeFileSync(path.join(tree, "binary.bin"), Buffer.from([1, 0, 2]));
    fs.symlinkSync("/etc/hostname", path.join(tree, "link.txt"));
    // The base moves on after the branch left: that is not this lane's work.
    fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later on main");

    const deps = { defaultBase: async () => "main" };
    const changes = await api.computeLaneChanges(tree, deps);
    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    assert.equal(changes.base, "main");
    assert.equal(changes.error, undefined);
    assert.deepEqual([...byPath.keys()].sort(), ["app.txt", "binary.bin", "link.txt", "new file.txt", "old.txt"]);
    assert.equal(byPath.get("app.txt").status, "modified");
    assert.equal(byPath.get("app.txt").additions, 1, "a commit counts");
    assert.equal(byPath.get("old.txt").status, "deleted", "uncommitted work counts");
    assert.equal(byPath.get("new file.txt").status, "untracked");
    assert.equal(byPath.get("new file.txt").additions, 2, "the last line counts without a newline");
    assert.equal(byPath.get("binary.bin").additions, 0);
    assert.equal(byPath.get("link.txt").additions, 0, "a link is not followed");
    assert.equal(changes.fileCount, 5);
    assert.equal(changes.additions, 3);
    assert.equal(changes.deletions, 1);
    assert.equal(changes.files[0].path, "new file.txt", "largest change first");

    const noBase = await api.computeLaneChanges(tree, { defaultBase: async () => "does-not-exist" });
    assert.equal(noBase.base, null, "with no base only the uncommitted work counts");
    assert.equal(new Map(noBase.files.map((file) => [file.path, file])).has("app.txt"), false);

    const unsafe = await api.computeLaneChanges(tree, { defaultBase: async () => "--output=/tmp/x" });
    assert.equal(unsafe.base, null, "a base that is no branch name never reaches git");

    const clean = await api.computeLaneChanges(repo, deps);
    assert.equal(clean.fileCount, 0);

    const empty = path.join(root, "empty");
    execFileSync("git", ["init", "-q", "-b", "main", empty]);
    fs.writeFileSync(path.join(empty, "first.txt"), "x\n");
    const noCommit = await api.computeLaneChanges(empty, deps);
    assert.equal(noCommit.fileCount, 1, "a repository with no commit lists its untracked files");

    const gone = await api.computeLaneChanges(path.join(root, "nowhere"), deps);
    assert.ok(gone.error, "a folder that is gone reports its own error");
    assert.equal((await api.computeLaneChanges("ssh://host/x", deps)).error !== undefined, true, "an SSH folder is not read here");

    let clock = 1_000;
    const now = () => clock;
    let reads = 0;
    const counting = { defaultBase: async () => (reads++, "main") };
    const first = await api.readLaneChanges([tree, repo, tree], counting, now);
    assert.deepEqual(Object.keys(first).sort(), [repo, tree].sort(), "a folder asked twice is read once");
    const seen = reads;
    await api.readLaneChanges([tree], counting, now);
    assert.equal(reads, seen, "a read within the cache window runs no git");
    clock += 6_000;
    await api.readLaneChanges([tree], counting, now);
    assert.ok(reads > seen, "an old read is read again");
    const many = Array.from({ length: api.MAX_LANE_READS + 5 }, (_, index) => path.join(root, `nowhere-${index}`));
    assert.equal(Object.keys(await api.readLaneChanges(many, counting, now)).length, api.MAX_LANE_READS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("source lanes: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
