// An untracked node_modules link is no one's work: the cleanup does not
// count it as a new file, and the removal takes the link out before git
// runs, never what it points at, and puts it back when the removal fails
// (src/main/worktree-setup/links.ts, git-worktrees.ts removeCopyWorktree,
// worktree-cleanup/inspect.ts readStatus). A held link goes back only with
// calls that never replace anything; every link left held is named; what
// each removed link read is kept verbatim in the audit log, on the cleanup
// path and the agent path alike. A real untracked file still counts.
// Throwaway repositories in the system temp folder.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const outputs = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-dependency-links-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  outputs.push(outfile);
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// Replaces fs.promises[name] for the length of fn; the bundles call it
// through the same object.
async function patched(name, replacement, fn) {
  const real = fs.promises[name];
  fs.promises[name] = (...args) => replacement(real, ...args);
  try {
    return await fn();
  } finally {
    fs.promises[name] = real;
  }
}

const readAudit = (file) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

async function main() {
  if (process.platform === "win32") {
    console.log("skipped: node_modules links are left as new files on Windows");
    return;
  }
  const [scanMod, removeMod, agent, gitWorktrees, links] = await Promise.all([
    bundle("src/main/worktree-cleanup/scan.ts", "scan"),
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/main/git-worktrees.ts", "gitWorktrees"),
    bundle("src/main/worktree-setup/links.ts", "links"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-dependency-links-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", "node_modules/\n", "ignore");
    commitFile(repo, "docs/readme.md", "docs\n", "docs");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const add = (name, branch) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      return dir;
    };
    const packages = path.join(repo, "node_modules");
    fs.mkdirSync(path.join(packages, "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(packages, "left-pad", "index.js"), "module.exports = 1;\n");
    const packagesIntact = () => assert.equal(fs.readFileSync(path.join(packages, "left-pad", "index.js"), "utf8"), "module.exports = 1;\n");

    const auditFile = path.join(home, "logs", "worktree-audit.jsonl");
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => {},
      invalidateGitCache: () => {},
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(auditFile),
      now: () => new Date(),
    };
    const checkOf = async (dir) => (await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: dir }]))[0];
    const codes = (entry) => entry.blockers.map((blocker) => blocker.code);
    const rowOf = async (dir) => (await scanMod.scanWorktreeCleanup(deps)).scan.rows.find((entry) => entry.path === dir || entry.id === dir);
    const removeIt = async (dir, fingerprint) =>
      (
        await removeMod.removeCleanupWorktrees(deps, {
          items: [{ repoRoot: repo, path: dir, fingerprint, confirmDirty: false, confirmUnmerged: false }],
          deleteMergedBranches: true,
        })
      ).outcomes[0];

    const linked = add("linked", "feat/linked");
    fs.symlinkSync(packages, path.join(linked, "node_modules"), "dir");
    assert.equal(git(linked, ["status", "--porcelain"]), "?? node_modules", "git lists the link as a new file");

    await check("a node_modules link is no unsaved file, on the screen or in the full check", async () => {
      assert.deepEqual((await rowOf(linked)).dirty, { tracked: 0, untracked: 0, inProgress: null });
      const entry = await checkOf(linked);
      assert.deepEqual(codes(entry), []);
      assert.equal(entry.localWork, null, JSON.stringify(entry.localWork));
    });

    await check("a real new file still counts, and a folder or file named node_modules is still read", async () => {
      fs.writeFileSync(path.join(linked, "notes.txt"), "mine\n");
      let entry = await checkOf(linked);
      assert.equal(entry.localWork.untracked, 1);
      assert.deepEqual(entry.localWork.paths, ["notes.txt"]);
      fs.rmSync(path.join(linked, "notes.txt"));
      const real = path.join(linked, "pkg", "node_modules");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "mine.js"), "1\n");
      entry = await checkOf(linked);
      assert.ok(entry.localWork.ignored.includes("pkg/node_modules/"), "not beside a package manifest: asked about");
      fs.rmSync(path.join(linked, "pkg"), { recursive: true, force: true });
      fs.writeFileSync(path.join(linked, "docs", "node_modules"), "notes\n");
      assert.equal((await checkOf(linked)).localWork.untracked, 1, "a file named node_modules is no link");
      fs.rmSync(path.join(linked, "docs", "node_modules"));
    });

    await check("the removal takes the link out, never what it points at, and the audit keeps what it read", async () => {
      const entry = await checkOf(linked);
      const outcome = await removeIt(linked, entry.fingerprint);
      assert.equal(outcome.status, "removed", JSON.stringify(outcome));
      assert.equal(fs.existsSync(linked), false);
      packagesIntact();
      const last = readAudit(auditFile).filter((line) => line.path === linked && line.outcome === "removed").pop();
      assert.deepEqual(last?.links, [{ path: "node_modules", text: packages }], JSON.stringify(last));
      assert.deepEqual(fs.readdirSync(trees).filter((name) => name.includes(".links-")), [], "nothing held is left beside it");
    });

    await check("a link alone in a folder of its own is no new file and is taken out too", async () => {
      const nested = add("nested-link", "feat/nested-link");
      fs.mkdirSync(path.join(nested, "pkg"));
      fs.symlinkSync(packages, path.join(nested, "pkg", "node_modules"), "dir");
      const entry = await checkOf(nested);
      assert.deepEqual(codes(entry), [], JSON.stringify(entry.blockers));
      assert.deepEqual((await rowOf(nested)).dirty, { tracked: 0, untracked: 0, inProgress: null }, "the overview agrees");
      // A folder whose name reads as a pathspec magic word is itself looked at.
      const magic = path.join(nested, ":(glob)pkg");
      fs.mkdirSync(magic);
      fs.writeFileSync(path.join(magic, "notes.txt"), "mine\n");
      assert.equal((await rowOf(nested)).dirty.untracked, 1);
      fs.rmSync(magic, { recursive: true, force: true });
      const outcome = await removeIt(nested, entry.fingerprint);
      assert.equal(outcome.status, "removed", JSON.stringify(outcome));
      packagesIntact();
    });

    await check("on Windows a node_modules link stays a new file", async () => {
      const dir = path.join(scratch, "windows");
      fs.mkdirSync(dir);
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      assert.equal(await links.isDependencyLink(dir, "node_modules"), true);
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        assert.equal(await links.isDependencyLink(dir, "node_modules"), false, "a junction there is asked about");
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });

    await check("a link a failed removal took out comes back exactly, dangling or relative", async () => {
      const dir = path.join(scratch, "links");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync("../gone/node_modules", path.join(dir, "node_modules"));
      const released = await links.prepareWorktreeRemoval(dir, ["node_modules"]);
      assert.equal(!!fs.lstatSync(path.join(dir, "node_modules"), { throwIfNoEntry: false }), false);
      assert.ok(released[0].held && !released[0].held.startsWith(dir + path.sep), "held outside the worktree");
      assert.deepEqual(await links.restoreWorktreeLinks(dir, released), []);
      assert.equal(fs.readlinkSync(path.join(dir, "node_modules")), "../gone/node_modules");
      assert.equal(fs.existsSync(path.dirname(released[0].held)), false, "nothing left beside it");
      const again = await links.prepareWorktreeRemoval(dir, ["node_modules"]);
      await links.discardHeldLinks(again);
      assert.equal(!!fs.lstatSync(again[0].held, { throwIfNoEntry: false }), false, "once the worktree is gone, only the held link goes");
      assert.equal(fs.existsSync(path.dirname(again[0].held)), false);
    });

    await check("a held link never goes back over something new in its place", async () => {
      const dir = path.join(scratch, "held-over");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync("../gone/node_modules", path.join(dir, "node_modules"));
      const released = await links.prepareWorktreeRemoval(dir, ["node_modules"]);
      fs.writeFileSync(path.join(dir, "node_modules"), "new\n");
      assert.deepEqual(await links.restoreWorktreeLinks(dir, released), [{ path: "node_modules", held: released[0].held }]);
      assert.equal(fs.readFileSync(path.join(dir, "node_modules"), "utf8"), "new\n", "the new file stays");
      assert.equal(fs.readlinkSync(released[0].held), "../gone/node_modules", "the link is kept where it was held");
    });

    await check("round 5: a put-back whose hard link fails never falls back to a rename", async () => {
      const dir = path.join(scratch, "no-fallback");
      fs.mkdirSync(dir);
      const held = path.join(dir, "held");
      const to = path.join(dir, "back");
      fs.writeFileSync(held, "held file\n");
      let renamed = false;
      const back = await patched(
        "link",
        async () => {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        },
        () =>
          patched(
            "rename",
            async (real, from, dest) => {
              renamed = true;
              // Made in the gap after a last look: a rename would replace it.
              fs.writeFileSync(to, "made since\n");
              return real(from, dest);
            },
            () => links.putBackNoReplace(held, to),
          ),
      );
      assert.equal(back, false, "it stays held");
      assert.equal(renamed, false, "no rename was tried");
      assert.equal(fs.readFileSync(held, "utf8"), "held file\n");
      assert.equal(fs.existsSync(to), false);
    });

    // Two links; the second is swapped for a file while it is taken out, and
    // something is made where the first was, so the first cannot go back.
    // The held paths an error names ("<link> at <where>", every one).
    const heldIn = (message) =>
      (/ Its node_modules links are kept: (.+)\.$/.exec(message)?.[1]?.split("; ") ?? []).map((entry) => entry.split(" at ")[1]);
    const twoLinks = (name) => {
      const dir = path.join(scratch, name);
      fs.mkdirSync(path.join(dir, "a"), { recursive: true });
      fs.mkdirSync(path.join(dir, "b"), { recursive: true });
      fs.symlinkSync(packages, path.join(dir, "a", "node_modules"), "dir");
      fs.symlinkSync(packages, path.join(dir, "b", "node_modules"), "dir");
      return dir;
    };

    await check("round 5: a link that changed while taken out names every link still held", async () => {
      const dir = twoLinks("changed-partway");
      const second = path.join(dir, "b", "node_modules");
      const err = await patched(
        "rename",
        async (real, from, dest) => {
          if (from === second) {
            fs.writeFileSync(path.join(dir, "a", "node_modules"), "made since\n");
            fs.unlinkSync(second);
            fs.writeFileSync(second, "swapped\n");
          }
          return real(from, dest);
        },
        () => links.prepareWorktreeRemoval(dir, ["a/node_modules", "b/node_modules"]).then(() => null, (error) => error),
      );
      assert.ok(err, "the removal stops");
      assert.match(err.message, /b\/node_modules changed while it was being taken out/);
      const held = heldIn(err.message);
      assert.deepEqual(err.held.map((link) => link.path), ["a/node_modules"], "the link is named, apart from the message too");
      assert.deepEqual(held, err.held.map((link) => link.held), err.message);
      assert.equal(fs.readlinkSync(held[0]), packages, "the first link, named where it is held");
      assert.equal(fs.readFileSync(second, "utf8"), "swapped\n", "the swapped file went back");
      assert.equal(fs.readFileSync(path.join(dir, "a", "node_modules"), "utf8"), "made since\n");
    });

    await check("round 5: a link that could not be taken out names every link still held", async () => {
      const dir = twoLinks("stuck-partway");
      const second = path.join(dir, "b", "node_modules");
      const err = await patched(
        "rename",
        async (real, from, dest) => {
          if (from === second) {
            fs.writeFileSync(path.join(dir, "a", "node_modules"), "made since\n");
            throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
          }
          return real(from, dest);
        },
        () => links.prepareWorktreeRemoval(dir, ["a/node_modules", "b/node_modules"]).then(() => null, (error) => error),
      );
      assert.ok(err, "the removal stops");
      assert.match(err.message, /Could not take out the linked folder b\/node_modules/);
      const held = heldIn(err.message);
      assert.deepEqual(err.held.map((link) => link.path), ["a/node_modules"], "the link is named, apart from the message too");
      assert.deepEqual(held, err.held.map((link) => link.held), err.message);
      assert.equal(fs.readlinkSync(held[0]), packages);
      assert.equal(fs.readlinkSync(second), packages, "the second link never moved");
    });

    await check("only an untracked link in the worktree's own folder is taken out", async () => {
      const dir = add("renamed-link", "feat/renamed-link");
      // A tracked link, and a tracked file whose name reads like a status line.
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      fs.writeFileSync(path.join(dir, "?? node_modules"), "x\n");
      git(dir, ["add", "-f", "node_modules", "?? node_modules"]);
      git(dir, ["commit", "-q", "-m", "tracked"]);
      git(dir, ["mv", "?? node_modules", "renamed"]);
      assert.deepEqual(await gitWorktrees.untrackedDependencyLinks(dir), [], "a rename's source is no untracked entry");
      const elsewhere = path.join(scratch, "elsewhere");
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.symlinkSync(packages, path.join(elsewhere, "node_modules"), "dir");
      fs.symlinkSync(elsewhere, path.join(dir, "via"), "dir");
      assert.equal(await links.isDependencyLink(dir, "via/node_modules"), false, "through a linked parent it is somewhere else");
      assert.equal(await links.isDependencyLink(dir, "node_modules"), true);
    });

    await check("a link that cannot be taken out stops the removal and stays", async () => {
      const dir = path.join(scratch, "stuck");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      fs.chmodSync(dir, 0o555);
      try {
        await assert.rejects(links.prepareWorktreeRemoval(dir, ["node_modules"]), /node_modules/);
        assert.equal(fs.readlinkSync(path.join(dir, "node_modules")), packages);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      assert.deepEqual(fs.readdirSync(scratch).filter((name) => name.startsWith("stuck.links-")), [], "no empty holding folder left");
    });

    await check("round 5: the audit keeps every link verbatim", async () => {
      const file = path.join(scratch, "verbatim.jsonl");
      const log = agent.createWorktreeAuditLog(file);
      const many = Array.from({ length: 60 }, (_, i) => ({ path: `p${i}/node_modules`, text: `../x\u0007‮${i}/${"y".repeat(1_200)}` }));
      await log({ action: "remove", outcome: "removed", caller: { role: "user" }, repo, workspaceId: null, path: "/tmp/fake", links: many });
      assert.deepEqual(readAudit(file).at(-1).links, many);
    });

    await check("a link whose text is no UTF-8 stays a new file", async () => {
      const dir = path.join(scratch, "latin1");
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.symlinkSync(Buffer.from([0x2e, 0x2e, 0x2f, 0x63, 0x61, 0x66, 0xe9]), path.join(dir, "node_modules"));
      } catch {
        return; // a file system that refuses such a name has no such link
      }
      assert.equal(await links.isDependencyLink(dir, "node_modules"), false, "read back it would point elsewhere");
      assert.deepEqual(await links.prepareWorktreeRemoval(dir, ["node_modules"]).catch(() => "refused"), "refused");
      assert.equal(fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink(), true, "it stays where it was");
    });

    await check("every held link is named on the cleanup screen and in the audit, however long git's message", async () => {
      const dir = add(`held-${"x".repeat(60)}`, "feat/held");
      for (const name of ["pkg-a", "pkg-b", "pkg-c"]) {
        fs.mkdirSync(path.join(dir, name));
        fs.symlinkSync(packages, path.join(dir, name, "node_modules"), "dir");
      }
      const entry = await checkOf(dir);
      assert.deepEqual(codes(entry), [], JSON.stringify(entry.blockers));
      const real = deps.processesUnderCwds;
      // Once it is aside, files take the links' places: git refuses them
      // and the links cannot go back.
      deps.processesUnderCwds = async (dirs) => {
        for (const where of dirs) {
          if (!path.basename(where).endsWith(".codara-removing")) continue;
          for (const name of ["pkg-a", "pkg-b", "pkg-c"]) fs.writeFileSync(path.join(where, name, "node_modules"), "made since\n");
        }
        return real(dirs);
      };
      let result;
      try {
        result = await removeIt(dir, entry.fingerprint);
      } finally {
        deps.processesUnderCwds = real;
      }
      assert.notEqual(result.status, "removed", JSON.stringify(result));
      assert.equal(fs.existsSync(dir), true, "the folder stays");
      const named = ["pkg-a", "pkg-b", "pkg-c"].map((name) => `${name}/node_modules at `);
      for (const entry of named) assert.ok(result.message.includes(entry), `${entry} in: ${result.message}`);
      const held = readAudit(auditFile).filter((line) => line.path === dir && line.outcome === "refused").pop()?.heldLinks ?? [];
      assert.deepEqual(held.map((link) => link.path), ["pkg-a/node_modules", "pkg-b/node_modules", "pkg-c/node_modules"]);
      for (const link of held) assert.equal(fs.readlinkSync(link.held), packages, "each is held where it is named");
      packagesIntact();
    });

    await check("round 2: held links stay named however long the message before them", async () => {
      // Once it is aside, a file takes the link's place (git refuses it, the
      // link cannot go back) and a folder takes the worktree's own place, so
      // it stays aside: the error names both long paths before the link.
      const dir = add(`long-${"y".repeat(225)}`, "feat/long-held");
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      const entry = await checkOf(dir);
      assert.deepEqual(codes(entry), [], JSON.stringify(entry.blockers));
      const real = deps.processesUnderCwds;
      let aside = null;
      deps.processesUnderCwds = async (dirs) => {
        for (const where of dirs) {
          if (!path.basename(where).endsWith(".codara-removing")) continue;
          aside = where;
          fs.writeFileSync(path.join(where, "node_modules"), "made since\n");
          fs.mkdirSync(dir);
        }
        return real(dirs);
      };
      let result;
      try {
        result = await removeIt(dir, entry.fingerprint);
      } finally {
        deps.processesUnderCwds = real;
      }
      assert.notEqual(result.status, "removed", JSON.stringify(result));
      const held = readAudit(auditFile).filter((line) => line.path === dir && line.outcome === "refused").pop()?.heldLinks ?? [];
      assert.equal(held.length, 1, JSON.stringify(result));
      const named = result.message.indexOf(`node_modules at ${held[0].held}.`);
      assert.ok(named > 400, `the message before the held link is long enough to be cut: ${result.message}`);
      assert.equal(fs.readlinkSync(held[0].held), packages);
      packagesIntact();
      const notes = path.join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "codara-aside");
      for (const name of fs.readdirSync(notes)) {
        if (JSON.parse(fs.readFileSync(path.join(notes, name), "utf8")).aside === aside) fs.rmSync(path.join(notes, name));
      }
      for (const where of [dir, aside, path.dirname(held[0].held)]) fs.rmSync(where, { recursive: true, force: true });
      git(repo, ["worktree", "prune"]);
    });

    // Once it is aside, the archive's disk cannot be read and a file takes
    // the link's place, so the folder goes back without its link.
    const failArchiveAside = (where, fn) =>
      patched(
        "statfs",
        async () => {
          const parent = path.dirname(where);
          const aside = fs.readdirSync(parent).find((name) => name.endsWith(".codara-removing") && name.includes(path.basename(where)));
          if (aside) fs.writeFileSync(path.join(parent, aside, "node_modules"), "made since\n");
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
        fn,
      );

    await check("round 3: a failed archive names the links it left held, on the screen and in the audit", async () => {
      const dir = add("archive-held", "feat/archive-held");
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      fs.mkdirSync(path.join(dir, "pkg", "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "pkg", "node_modules", "mine.js"), "1\n");
      const entry = await checkOf(dir);
      assert.ok(entry.localWork?.ignored?.includes("pkg/node_modules/"), JSON.stringify(entry.localWork));
      deps.archiveRoot = () => path.join(scratch, "archive");
      let result;
      try {
        result = await failArchiveAside(dir, async () =>
          (
            await removeMod.removeCleanupWorktrees(
              deps,
              {
                items: [{ repoRoot: repo, path: dir, fingerprint: entry.fingerprint, confirmDirty: true, confirmUnmerged: false }],
                deleteMergedBranches: false,
              },
              { archiveIgnored: true },
            )
          ).outcomes[0],
        );
      } finally {
        delete deps.archiveRoot;
      }
      assert.equal(result.code, "ARCHIVE_FAILED", JSON.stringify(result));
      assert.equal(fs.readFileSync(path.join(dir, "pkg", "node_modules", "mine.js"), "utf8"), "1\n", "the folder is back");
      const held = readAudit(auditFile).filter((line) => line.path === dir && line.outcome === "refused").pop()?.heldLinks ?? [];
      assert.deepEqual(held.map((link) => link.path), ["node_modules"], JSON.stringify(result));
      assert.deepEqual(heldIn(result.message), held.map((link) => link.held), result.message);
      assert.equal(fs.readlinkSync(held[0].held), packages, "held where it is named");
      packagesIntact();
    });

    await check("round 2: a removal without its move aside leaves a node_modules link to git, as before", async () => {
      const dir = add("no-aside", "feat/no-aside");
      fs.symlinkSync(packages, path.join(dir, "node_modules"), "dir");
      const result = await gitWorktrees.removeCopyWorktree({ repoCwd: repo, worktreePath: dir, branch: "feat/no-aside", force: false, removeOrphanDir: false });
      assert.equal(result.ok, false, "git still refuses the untracked link");
      assert.equal(fs.readlinkSync(path.join(dir, "node_modules")), packages, "the link never moved");
      assert.deepEqual(fs.readdirSync(trees).filter((name) => name.startsWith("no-aside.links-")), [], "nothing was held");
      packagesIntact();
    });

    await check("links held when Studio stopped mid-removal come back with the folder", async () => {
      const dir = add("crashed", "feat/crashed");
      fs.symlinkSync("../somewhere/node_modules", path.join(dir, "node_modules"));
      const notes = path.join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "codara-aside");
      let noted = null;
      // The recheck never answers: Studio stopped with the folder aside.
      const stopped = gitWorktrees.removeCopyWorktree({
        repoCwd: repo,
        worktreePath: dir,
        branch: "feat/crashed",
        removeOrphanDir: false,
        aside: {
          recheck: () => {
            noted = fs.readdirSync(notes).map((name) => JSON.parse(fs.readFileSync(path.join(notes, name), "utf8")));
            return new Promise(() => {});
          },
        },
      });
      void stopped;
      for (let i = 0; i < 200 && !noted; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(noted, "it got as far as the move aside");
      assert.equal(fs.existsSync(dir), false, "the folder is aside, its link held");
      assert.deepEqual(noted.flatMap((note) => (note.links ?? []).map((link) => link.path)), ["node_modules"], "the note names the held link");
      const back = await gitWorktrees.restoreAsideWorktrees(repo);
      assert.deepEqual(back, { restored: [dir], stuck: [] });
      assert.equal(fs.readlinkSync(path.join(dir, "node_modules")), "../somewhere/node_modules", "the link is back as it read");
      assert.deepEqual(fs.readdirSync(trees).filter((name) => name.startsWith("crashed.links-")), [], "nothing held is left");
    });

    await check("a note naming a held link outside its holding folder is no note of Studio's", async () => {
      const notes = path.join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "codara-aside");
      const original = path.join(trees, "forged");
      const aside = path.join(trees, ".forged.codara-removing");
      const elsewhere = path.join(scratch, "someone-else.txt");
      fs.mkdirSync(aside, { recursive: true });
      fs.writeFileSync(elsewhere, "theirs\n");
      const name = `${require("node:crypto").createHash("sha256").update(aside).digest("hex").slice(0, 24)}.json`;
      fs.mkdirSync(notes, { recursive: true });
      fs.writeFileSync(path.join(notes, name), JSON.stringify({ original, aside, links: [{ path: "node_modules", held: elsewhere }] }));
      const back = await gitWorktrees.restoreAsideWorktrees(repo);
      assert.deepEqual(back, { restored: [], stuck: [] }, "it is not acted on");
      assert.equal(fs.readFileSync(elsewhere, "utf8"), "theirs\n");
      assert.equal(fs.existsSync(aside), true);
      fs.rmSync(path.join(notes, name));
    });

    await check("round 2: a noted link no longer where it was held is not named as stuck", async () => {
      const notes = path.join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "codara-aside");
      const original = path.join(trees, "already-back");
      const aside = path.join(trees, ".already-back.codara-removing");
      fs.mkdirSync(original, { recursive: true });
      const name = `${require("node:crypto").createHash("sha256").update(aside).digest("hex").slice(0, 24)}.json`;
      fs.mkdirSync(notes, { recursive: true });
      const held = `${original}.links-gone/0`;
      fs.writeFileSync(path.join(notes, name), JSON.stringify({ original, aside, links: [{ path: "node_modules", held }] }));
      const back = await gitWorktrees.restoreAsideWorktrees(repo);
      assert.deepEqual(back, { restored: [], stuck: [] });
      assert.equal(fs.existsSync(path.join(notes, name)), false, "the note is cleared");
      fs.rmSync(original, { recursive: true });
    });

    // ── The agent path ─────────────────────────────────────────────────────
    await check("round 5: the agent removal's own audit entry names the links that went", async () => {
      let ids = 0;
      let scans = 0;
      let made = null;
      const agentState = {
        state: structuredClone(h.state),
        prefs: { agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false, agentWorktreeRegenerableIgnoredByRepo: {} },
      };
      const agentDeps = {
        loadState: async () => structuredClone(agentState.state),
        updateState: async (mutator) => {
          agentState.state = await mutator(structuredClone(agentState.state));
          return agentState.state;
        },
        loadPreferences: async () => agentState.prefs,
        publishState: () => undefined,
        invalidateGitCache: () => undefined,
        getRun: async () => null,
        listRuns: async () => [],
        paneWorkspaceId: async (paneId) => (paneId === "pane-maker" ? "ws-repo" : null),
        sessionCwd: () => null,
        sessionsUnderCwd: () => [],
        listRendererTerminals: async () => [],
        workspaceHeld: async () => false,
        // The second scan is the check made under the lock, after its git
        // status: a link made then goes with the folder.
        processesUnderCwd: async (dir) => {
          if (made && fs.existsSync(made.path) && fs.realpathSync(made.path) === dir && ++scans === 2) {
            fs.symlinkSync(packages, path.join(made.path, "node_modules"), "dir");
          }
          return [];
        },
        github: {
          listPullRequestsForHead: async () => [],
          listMergedPullRequests: async () => [],
          listPullRequestsForCommit: async () => [],
          listPullRequestStatesForHead: async () => [],
        },
        sendAgentEvent: () => undefined,
        audit: agent.createWorktreeAuditLog(auditFile),
        worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
        now: () => new Date(),
        randomId: () => (++ids).toString(16).padStart(8, "a"),
      };
      const maker = { role: "studio", client: "claude-code", paneId: "pane-maker" };
      made = await agent.createAgentWorktree(maker, { branch: "agent/linked" }, agentDeps);
      assert.equal(made.ok, true, JSON.stringify(made));
      const result = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
      assert.equal(result.removed, true, JSON.stringify(result));
      assert.equal(scans >= 2, true, "the link was made during the check under the lock");
      packagesIntact();
      const last = readAudit(auditFile).filter((line) => line.workspaceId === made.workspaceId && line.outcome === "removed").pop();
      assert.deepEqual(last?.links, [{ path: "node_modules", text: packages }], JSON.stringify(last));

      // A failed agent removal: the links it left held are in its audit line.
      made = null;
      const failing = await agent.createAgentWorktree(maker, { branch: "agent/held" }, agentDeps);
      assert.equal(failing.ok, true, JSON.stringify(failing));
      scans = 0;
      made = failing;
      const realHeld = agentDeps.workspaceHeld;
      // Asked once the folder is aside: a file takes the link's place, so it
      // cannot go back, and a tab "opened" puts the folder back.
      agentDeps.workspaceHeld = async (_id, dirs) => {
        const aside = dirs.find((where) => path.basename(where).endsWith(".codara-removing"));
        if (!aside) return realHeld(_id, dirs);
        fs.writeFileSync(path.join(aside, "node_modules"), "made since\n");
        return true;
      };
      let refused;
      try {
        refused = await agent.removeAgentWorktree(maker, { workspaceId: failing.workspaceId }, agentDeps);
      } finally {
        agentDeps.workspaceHeld = realHeld;
      }
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.heldLinks?.length, 1, JSON.stringify(refused));
      const line = readAudit(auditFile).filter((entry) => entry.workspaceId === failing.workspaceId && entry.outcome === "refused").pop();
      assert.deepEqual(line?.heldLinks, refused.heldLinks, JSON.stringify(line));
      assert.equal(fs.readlinkSync(line.heldLinks[0].held), packages, "held where the audit says");
      packagesIntact();

      // round 3: an archive that failed names the links it left held too.
      made = null;
      const archiving = await agent.createAgentWorktree(maker, { branch: "agent/archive-held" }, agentDeps);
      assert.equal(archiving.ok, true, JSON.stringify(archiving));
      scans = 0;
      made = archiving;
      fs.mkdirSync(path.join(archiving.path, "pkg", "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(archiving.path, "pkg", "node_modules", "mine.js"), "1\n");
      agentDeps.archiveRoot = () => path.join(scratch, "agent-archive");
      let unarchived;
      try {
        unarchived = await failArchiveAside(archiving.path, () =>
          agent.removeAgentWorktree(maker, { workspaceId: archiving.workspaceId }, agentDeps),
        );
      } finally {
        delete agentDeps.archiveRoot;
      }
      assert.equal(unarchived.code, "WORKTREE_ARCHIVE_FAILED", JSON.stringify(unarchived));
      assert.equal(fs.readFileSync(path.join(archiving.path, "pkg", "node_modules", "mine.js"), "utf8"), "1\n", "the folder is back");
      assert.equal(unarchived.heldLinks?.length, 1, JSON.stringify(unarchived));
      const archiveLine = readAudit(auditFile).filter((entry) => entry.workspaceId === archiving.workspaceId && entry.outcome === "refused").pop();
      assert.deepEqual(archiveLine?.heldLinks, unarchived.heldLinks, JSON.stringify(archiveLine));
      assert.equal(fs.readlinkSync(archiveLine.heldLinks[0].held), packages, "held where the audit says");
      packagesIntact();
    });
  } finally {
    for (const file of outputs) fs.rmSync(file, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
