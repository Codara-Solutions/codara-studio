// test-runner: heavy (peaks near 300 MB, like test-source-lanes)
"use strict";
// The Source Control warning that two running lanes would clash, on real git
// worktrees: a real conflict is named on both lanes, work that merges cleanly
// and a checkout with no commit are not, a pair is merged once for its two
// commits, and a broken folder or an SSH path says nothing. Plus the line it reads.
//
//   node scripts/test-lane-collisions.cjs

const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./main/git-lane-collisions";
        export * from "./shared/lane-collisions";
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

(async () => {
  const lib = await load();
  const names = { "/a": "feat/a", "/b": "feat/b", "/c": "feat/c" };
  const nameOf = (value) => names[value];
  assert.equal(lib.collisionText(undefined, nameOf), null);
  assert.equal(lib.collisionText([], nameOf), null);
  assert.equal(lib.collisionText([{ otherPath: "/b", files: [] }], nameOf), null);
  assert.equal(lib.collisionText([{ otherPath: "/b", files: ["src/session.ts"] }], nameOf), "session.ts clashes with feat/b if both merge.");
  assert.equal(lib.collisionText([{ otherPath: "/b", files: ["a.ts", "b.ts", "c.ts"] }], nameOf), "a.ts and 2 more clash with feat/b if both merge.");
  assert.equal(lib.collisionText([{ otherPath: "/b", files: ["a.ts"] }, { otherPath: "/c", files: ["z.ts"] }], nameOf), "a.ts clashes with feat/b and 1 more if both merge.");

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-lane-collisions-")));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = T\n\temail = t@example.invalid\n");
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "shared.ts"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(repo, "other.ts"), "alpha\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const tree = (name, file, text) => {
      const dir = path.join(root, name);
      git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, dir);
      if (file) {
        fs.writeFileSync(path.join(dir, file), text);
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", name);
      }
      return dir;
    };
    const a = tree("a", "shared.ts", "one\nA\nthree\n");
    const b = tree("b", "shared.ts", "one\nB\nthree\n");
    const clean = tree("clean", "other.ts", "alpha\nbeta\n");
    const same = tree("same", null);

    let merges = 0;
    const runGit = (cwd, args) =>
      new Promise((resolve, reject) => {
        execFile("git", ["-C", cwd, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
    const run = (cwd, args, opts) => {
      if (args.includes("merge-tree")) merges += 1;
      return runGit(cwd, args, opts);
    };
    const deps = { run, supported: async () => true };

    const found = await lib.readLaneCollisions([a, b, clean, same], deps);
    assert.deepEqual(found[a], [{ otherPath: b, files: ["shared.ts"] }], "named on the first lane");
    assert.deepEqual(found[b], [{ otherPath: a, files: ["shared.ts"] }], "and on the other");
    assert.equal(found[clean], undefined, "work that merges cleanly says nothing");
    assert.equal(found[same], undefined, "a checkout with no commit of its own says nothing");

    const counted = merges;
    await lib.readLaneCollisions([a, b, clean, same], deps);
    assert.equal(merges, counted, "a pair is merged once for its two commits");

    // A new commit is a new pair: fixing the clash clears it.
    fs.writeFileSync(path.join(b, "shared.ts"), "one\ntwo\nthree\n");
    git(b, "add", "-A");
    git(b, "commit", "-q", "-m", "back");
    const after = await lib.readLaneCollisions([a, b], deps);
    assert.deepEqual(after, {}, "the clash is gone with its commit");
    assert.ok(merges > counted);

    assert.deepEqual(await lib.readLaneCollisions([a], deps), {}, "one lane has nobody to clash with");
    assert.deepEqual(await lib.readLaneCollisions([a, path.join(root, "gone")], deps), {}, "a missing folder is skipped");
    assert.deepEqual(await lib.readLaneCollisions(["ssh://host/x", "ssh://host/y"], deps), {}, "SSH checkouts are not read");
    assert.deepEqual(await lib.readLaneCollisions([a, b], { run, supported: async () => false }), {}, "old git says nothing");
    const failing = { supported: async () => true, run: async (cwd, args) => {
      if (args.includes("merge-tree")) throw Object.assign(new Error("boom"), { code: 128, stdout: "" });
      return run(cwd, args);
    } };
    fs.writeFileSync(path.join(a, "shared.ts"), "one\nA2\nthree\n");
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "again");
    assert.deepEqual(await lib.readLaneCollisions([a, b], failing), {}, "a failed merge reads as no clash");

    // A custom merge driver is a program: this check runs in the background and must not start it.
    const marker = path.join(root, "driver-ran");
    const driven = path.join(root, "driven");
    fs.mkdirSync(driven);
    git(driven, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(driven, ".gitattributes"), "*.ts merge=custom\n");
    fs.writeFileSync(path.join(driven, "x.ts"), "one\n");
    git(driven, "add", "-A");
    git(driven, "commit", "-q", "-m", "init");
    const drivenTree = (name) => {
      const dir = path.join(root, `driven-${name}`);
      git(driven, "worktree", "add", "-q", "-b", name, dir);
      fs.writeFileSync(path.join(dir, "x.ts"), `${name}\n`);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", name);
      return dir;
    };
    const left = drivenTree("left");
    const right = drivenTree("right");
    const unprotected = await lib.readLaneCollisions([left, right], deps);
    assert.deepEqual(Object.keys(unprotected).length, 2, "with no driver set up, the attribute alone is an ordinary clash");
    git(driven, "config", "merge.custom.driver", `touch ${marker}`);
    fs.writeFileSync(path.join(left, "x.ts"), "left again\n");
    git(left, "add", "-A");
    git(left, "commit", "-q", "-m", "left again");
    assert.deepEqual(await lib.readLaneCollisions([left, right], deps), {}, "a repository with a driver is skipped");
    assert.equal(fs.existsSync(marker), false, "the driver did not run");

    // Nor a clean or smudge filter, which renormalizing during a merge would start.
    const filterMarker = path.join(root, "filter-ran");
    const filtered = path.join(root, "filtered");
    fs.mkdirSync(filtered);
    git(filtered, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(filtered, ".gitattributes"), "*.ts filter=mark\n");
    fs.writeFileSync(path.join(filtered, "x.ts"), "one\n");
    git(filtered, "add", "-A");
    git(filtered, "commit", "-q", "-m", "init");
    const filteredTree = (name) => {
      const dir = path.join(root, `filtered-${name}`);
      git(filtered, "worktree", "add", "-q", "-b", name, dir);
      fs.writeFileSync(path.join(dir, "x.ts"), `edit ${name}\n`);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", name);
      return dir;
    };
    const one = filteredTree("one");
    const two = filteredTree("two");
    git(filtered, "config", "merge.renormalize", "true");
    git(filtered, "config", "filter.mark.clean", `sh -c 'touch ${filterMarker}; cat'`);
    git(filtered, "config", "filter.mark.smudge", `sh -c 'touch ${filterMarker}; cat'`);
    assert.equal(Object.keys(await lib.readLaneCollisions([one, two], deps)).length, 2, "the clash is still found");
    assert.equal(fs.existsSync(filterMarker), false, "no filter ran");

    // A partial clone would fetch a missing file over the network to merge.
    git(filtered, "config", "remote.origin.promisor", "true");
    fs.writeFileSync(path.join(one, "y.ts"), "new\n");
    assert.deepEqual(await lib.readLaneCollisions([one, two], deps), {}, "a partial clone is skipped");
    git(filtered, "config", "--unset", "remote.origin.promisor");
    git(filtered, "config", "extensions.partialClone", "origin");
    assert.deepEqual(await lib.readLaneCollisions([one, two], deps), {}, "by either of its settings");
    git(filtered, "config", "--unset", "extensions.partialClone");
    git(filtered, "config", "remote.origin.partialCloneFilter", "blob:none");
    assert.deepEqual(await lib.readLaneCollisions([one, two], deps), {}, "or a filter left behind on its own");
    git(filtered, "config", "--unset", "remote.origin.partialCloneFilter");
    git(filtered, "config", "submodule.vendor.url", "https://example.invalid/vendor.git");
    assert.deepEqual(await lib.readLaneCollisions([one, two], deps), {}, "an initialized submodule may be a partial clone");
    git(filtered, "config", "--unset", "submodule.vendor.url");
    assert.equal(Object.keys(await lib.readLaneCollisions([one, two], deps)).length, 2, "with those gone it is checked again");
    const modules = path.join(filtered, ".git", "modules");
    fs.mkdirSync(modules);
    assert.deepEqual(await lib.readLaneCollisions([one, two], deps), {}, "a deinitialized submodule keeps its repository");
    fs.rmdirSync(modules);

    // A fetch is refused outright where git knows the setting.
    fs.writeFileSync(path.join(one, "x.ts"), "edit one again\n");
    fs.rmSync(path.join(one, "y.ts"), { force: true });
    git(one, "-c", "filter.mark.clean=cat", "-c", "filter.mark.smudge=cat", "add", "-A");
    git(one, "-c", "filter.mark.clean=cat", "-c", "filter.mark.smudge=cat", "commit", "-q", "-m", "again");
    let mergeEnv = null;
    await lib.readLaneCollisions([one, two], {
      supported: async () => true,
      run: (cwd, args, opts) => {
        if (args.includes("merge-tree")) mergeEnv = opts?.env ?? null;
        return run(cwd, args, opts);
      },
    });
    assert.equal(mergeEnv?.GIT_NO_LAZY_FETCH, "1", "the merge runs with lazy fetching off");

    console.log("lane collisions: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
