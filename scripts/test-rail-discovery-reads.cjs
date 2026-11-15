#!/usr/bin/env node
"use strict";

// The rail's repository discovery (discoverRepos in
// src/main/worktree-cleanup/inspect.ts) lists a repository's worktrees once,
// not once per workspace: every worktree of a repository lists the same ones.
// Counted with the spawn census (src/main/spawn-census.ts) on a real
// repository with three worktrees. When the environment changes how git
// finds the repository (GIT_DIR and the like), each workspace lists its own.
//
//   node scripts/test-rail-discovery-reads.cjs

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

const PROBE = `
require(process.env.CENSUS_MODULE);
const { discoverRepos } = require(process.env.INSPECT_MODULE);
(async () => {
  const state = JSON.parse(process.env.PROBE_STATE);
  const { repos } = await discoverRepos(state);
  console.log(JSON.stringify(repos.map((repo) => ({ root: repo.root, workspaces: repo.workspaces.map((ws) => ws.id), registrations: repo.registrations.length }))));
})().catch((error) => { console.error(error); process.exit(1); });
`;

async function main() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-discovery-")));
  let inspectModule = null;
  try {
    // Next to node_modules, so the packages left out of the bundle resolve.
    const cacheDir = path.join(ROOT, "node_modules", ".cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    inspectModule = path.join(cacheDir, `rail-discovery-${process.pid}.cjs`);
    const build = (entry, outfile) =>
      esbuild.build({
        entryPoints: [path.join(ROOT, entry)],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile,
        alias: { "@shared": path.join(ROOT, "src", "shared") },
        external: ["electron", "ssh2", "cpu-features"],
        logLevel: "silent",
      });
    await build("src/main/spawn-census.ts", path.join(dir, "census.cjs"));
    await build("src/main/worktree-cleanup/inspect.ts", inspectModule);

    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.invalid"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "a"]);
    const workspaces = [{ id: "main", name: "main", cwd: repo, color: "#000", workers: [] }];
    for (const lane of ["one", "two", "three"]) {
      const tree = path.join(dir, lane);
      git(repo, ["worktree", "add", "-q", "-b", lane, tree]);
      workspaces.push({
        id: lane,
        name: lane,
        cwd: tree,
        color: "#000",
        workers: [],
        copyBranch: { repoCwd: repo, branch: lane, baseBranch: "main", city: lane, mode: "fork", createdAt: new Date().toISOString() },
      });
    }

    const census = path.join(dir, "census.json");
    const probe = (extraEnv) => {
      fs.rmSync(census, { force: true });
      const result = spawnSync(process.execPath, ["-e", PROBE], {
        encoding: "utf8",
        env: {
          ...gitEnv,
          ...extraEnv,
          CODARA_SPAWN_CENSUS: census,
          CENSUS_MODULE: path.join(dir, "census.cjs"),
          INSPECT_MODULE: inspectModule,
          PROBE_STATE: JSON.stringify({ workspaces, activeWorkspaceId: "main" }),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const repos = JSON.parse(result.stdout.trim().split("\n").pop());
      return { repos, counts: JSON.parse(fs.readFileSync(census, "utf8")).byProgram };
    };
    const { repos, counts } = probe({});
    assert.equal(repos.length, 1, "one repository");
    assert.deepEqual(repos[0].workspaces, ["main", "one", "two", "three"], "every workspace under it");
    assert.equal(repos[0].registrations, 4, "with its four worktrees");
    assert.equal(counts["git worktree"], 1, `one worktree listing for four workspaces (${counts["git worktree"]})`);
    console.log("PASS the rail lists a repository's worktrees once, not once per workspace");

    // A relative GIT_DIR is resolved from each folder: the files say one
    // repository, git reads four. Each workspace lists its own.
    for (const ws of workspaces) git(dir, ["init", "-q", "--bare", "-b", "main", path.join(ws.cwd, ".alternate")]);
    const alternate = probe({ GIT_DIR: ".alternate" });
    assert.equal(alternate.counts["git worktree"], 4, `GIT_DIR=.alternate: one listing per workspace (${alternate.counts["git worktree"]})`);
    console.log("PASS an environment that changes how git finds the repository lists per workspace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (inspectModule) fs.rmSync(inspectModule, { force: true });
  }
}

main().catch((error) => {
  console.error("FAIL the rail's repository discovery");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
