// Finished work the cleanup screen and the rail used to miss, and the edges
// that must still hold work back (src/main/worktree-cleanup/inspect.ts,
// merged-pull-request-stack.ts, agent-worktrees.ts, worktree-setup/links.ts,
// pull-request-reads.ts):
// - a pull request merged into a long-lived branch other than the default
//   (staging) proves the worktree merged, but only for a tip that is exactly
//   its head, while that branch on the remote still holds the merge;
// - a module terraform init cloned under .terraform/modules is no nested
//   checkout while nothing in it is anyone's work, and .terraform/ beside its
//   lock file is regenerable; a real nested checkout or worktree still blocks;
// - an untracked node_modules link is no unsaved file, the removal takes the
//   link out and never what it points at; a real untracked file still counts;
// - every open pull request of a repository is read, not the first twelve.
// Throwaway repositories with a bare remote; GitHub is stubbed.
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
  const outfile = path.join(cacheDir, `spark-finished-work-${name}-${process.pid}.cjs`);
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

async function main() {
  const [inspect, scanMod, removeMod, agent, reads, github] = await Promise.all([
    bundle("src/main/worktree-cleanup/inspect.ts", "inspect"),
    bundle("src/main/worktree-cleanup/scan.ts", "scan"),
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/main/worktree-cleanup/pull-request-reads.ts", "reads"),
    bundle("src/main/github-cli.ts", "github"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-finished-work-")));
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
    commitFile(repo, ".gitignore", "node_modules/\n.terraform/\n", "ignore");
    commitFile(repo, "infra/main.tf", 'module "vpc" {}\n', "infra");
    commitFile(repo, "infra/.terraform.lock.hcl", "# lock\n", "lock");
    commitFile(repo, "docs/readme.md", "docs\n", "docs");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    const main = git(repo, ["rev-parse", "origin/main"]);

    const add = (name, branch) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      return dir;
    };

    // ── Merged into staging ────────────────────────────────────────────────
    const site = add("site", "feat/site");
    const siteFirst = commitFile(site, "page.html", "<p>one</p>\n", "page");
    const siteTip = commitFile(site, "page.html", "<p>two</p>\n", "page two");
    git(site, ["push", "-q", "-u", "origin", "feat/site"]);
    const hub = path.join(scratch, "hub");
    execFileSync("git", ["clone", "-q", origin, hub]);
    git(hub, ["checkout", "-q", "-b", "staging", "origin/main"]);
    git(hub, ["merge", "-q", "--no-ff", "-m", "Merge pull request #21", "origin/feat/site"]);
    const merge21 = git(hub, ["rev-parse", "HEAD"]);
    git(hub, ["push", "-q", "origin", "staging"]);
    git(repo, ["fetch", "-q", "origin"]);
    const pr21 = {
      number: 21,
      url: "https://example.invalid/pull/21",
      headRefName: "feat/site",
      headRefOid: siteTip,
      baseRefName: "staging",
      isCrossRepository: false,
      mergeCommitOid: merge21,
    };
    const repoContext = (merged) => ({
      root: repo,
      name: "repo",
      registrations: [],
      mainPath: repo,
      workspaces: [],
      base: { name: "origin/main", commit: main },
      tracking: new Map(),
      targets: new Map(),
      pullRequests: { open: [], merged },
    });
    const onMain = { name: "origin/main", commit: main };

    await check("staging: a tip that is the head of a pull request merged into staging reads merged there", async () => {
      const facts = await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain);
      assert.equal(facts.state, "merged", JSON.stringify(facts));
      assert.equal(facts.proof, "pull-request");
      assert.deepEqual(facts.pullRequest, { number: 21, url: pr21.url });
      assert.equal(facts.target, "origin/staging", "judged where it landed");
      assert.equal(facts.targetCommit, merge21);
    });

    await check("staging: a tip with commits past the merged head, or behind it, stays unmerged", async () => {
      const later = commitFile(site, "page.html", "<p>three</p>\n", "after the merge");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), later, "feat/site", onMain)).state, "unmerged");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteFirst, "feat/site", onMain)).state, "unmerged");
      git(site, ["reset", "-q", "--hard", siteTip]);
    });

    await check("staging: rewound on the remote, or a base that is not long-lived, proves nothing", async () => {
      // Another branch name holding the same merge: not long-lived, not the worktree's base.
      git(hub, ["push", "-q", "origin", "staging:feat/other"]);
      git(repo, ["fetch", "-q", "origin"]);
      const other = { ...pr21, baseRefName: "feat/other" };
      assert.equal((await inspect.mergeFacts(repoContext([other]), siteTip, "feat/site", onMain)).state, "unmerged");
      // GitHub's staging rewound past the merge; the local tracking ref still has it.
      git(hub, ["push", "-q", "-f", "origin", "origin/main:refs/heads/staging"]);
      assert.equal(git(repo, ["rev-parse", "origin/staging"]), merge21, "the tracking ref is stale");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain)).state, "unmerged");
      // No merge commit known: nothing to look for.
      git(hub, ["push", "-q", "-f", "origin", "staging"]);
      assert.equal((await inspect.mergeFacts(repoContext([{ ...pr21, mergeCommitOid: null }]), siteTip, "feat/site", onMain)).state, "unmerged");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain)).state, "merged");
    });

    // ── The cleanup harness ────────────────────────────────────────────────
    const infra = add("infra", "feat/infra");
    const linked = add("linked", "feat/linked");
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
      pulls: { open: [], merged: [] },
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
      pullRequests: async () => h.pulls,
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      now: () => new Date(),
    };
    const checkOf = async (dir) => (await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: dir }]))[0];
    const codes = (entry) => entry.blockers.map((blocker) => blocker.code);

    // ── Terraform ──────────────────────────────────────────────────────────
    const moduleSource = path.join(scratch, "module.git");
    const moduleWork = path.join(scratch, "module-work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", moduleSource]);
    execFileSync("git", ["clone", "-q", moduleSource, moduleWork]);
    commitFile(moduleWork, "main.tf", 'variable "cidr" {}\n', "module");
    git(moduleWork, ["push", "-q", "origin", "main"]);
    git(moduleWork, ["tag", "v1.0.0"]);
    git(moduleWork, ["push", "-q", "origin", "v1.0.0"]);
    const vpc = path.join(infra, "infra", ".terraform", "modules", "vpc");
    fs.mkdirSync(path.dirname(vpc), { recursive: true });
    // As terraform init does it: a clone, checked out at the tag asked for.
    execFileSync("git", ["clone", "-q", moduleSource, vpc]);
    git(vpc, ["checkout", "-q", "v1.0.0"]);
    fs.writeFileSync(path.join(infra, "infra", ".terraform", "modules", "modules.json"), "{}\n");
    fs.mkdirSync(path.join(infra, "infra", ".terraform", "providers"), { recursive: true });
    fs.writeFileSync(path.join(infra, "infra", ".terraform", "providers", "plugin"), "binary\n");

    await check("terraform: a module init cloned is no nested checkout, and .terraform/ beside its lock file regenerates", async () => {
      const entry = await checkOf(infra);
      assert.deepEqual(codes(entry), [], JSON.stringify(entry.blockers));
      assert.equal(entry.localWork, null, JSON.stringify(entry.localWork));
      assert.equal(agent.isRegenerableIgnored("infra/.terraform/", [], agent.packageRootTester(infra)), true);
      assert.equal(agent.isRegenerableIgnored(".terraform/", []), true, "at the root too");
    });

    await check("terraform: a module with an edit, an untracked file or a commit of its own is a checkout", async () => {
      fs.writeFileSync(path.join(vpc, "main.tf"), "edited\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "an edit");
      git(vpc, ["checkout", "-q", "--", "main.tf"]);
      fs.writeFileSync(path.join(vpc, "notes.txt"), "mine\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "an untracked file");
      fs.rmSync(path.join(vpc, "notes.txt"));
      git(vpc, ["checkout", "-q", "-b", "local"]);
      commitFile(vpc, "extra.tf", "# mine\n", "local commit");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a commit no remote branch or tag holds");
      git(vpc, ["checkout", "-q", "v1.0.0"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a local branch no remote branch holds");
      git(vpc, ["branch", "-q", "-D", "local"]);
      fs.writeFileSync(path.join(vpc, "stash.tf"), "x\n");
      git(vpc, ["add", "stash.tf"]);
      git(vpc, ["stash", "-q"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a stash");
      git(vpc, ["stash", "drop", "-q"]);
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      assert.deepEqual(codes(await checkOf(infra)), [], "clean again");
    });

    await check("terraform: a checkout elsewhere in .terraform/, a .git file, or a folder without a lock file still blocks", async () => {
      const hand = path.join(infra, "infra", ".terraform", "hand");
      execFileSync("git", ["init", "-q", hand]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "not a module folder");
      fs.rmSync(hand, { recursive: true, force: true });
      const pointer = path.join(infra, "infra", ".terraform", "modules", "sub");
      fs.mkdirSync(pointer);
      fs.writeFileSync(path.join(pointer, ".git"), `gitdir: ${path.join(repo, ".git")}\n`);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a .git file points elsewhere");
      fs.rmSync(pointer, { recursive: true, force: true });
      const docs = path.join(infra, "docs", ".terraform");
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, "state"), "x\n");
      assert.deepEqual((await checkOf(infra)).localWork.ignored, ["docs/.terraform/"], "no lock file beside it");
      fs.rmSync(docs, { recursive: true, force: true });
    });

    await check("terraform: a worktree registered inside a module folder still blocks", async () => {
      const inner = path.join(infra, "infra", ".terraform", "modules", "wt");
      git(repo, ["worktree", "add", "-q", "--detach", inner, "main"]);
      try {
        const ctxCheck = await checkOf(infra);
        assert.ok(codes(ctxCheck).includes("NESTED_CHECKOUT"), JSON.stringify(ctxCheck.blockers));
      } finally {
        git(repo, ["worktree", "remove", "--force", inner]);
      }
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    // ── A node_modules link ────────────────────────────────────────────────
    const packages = path.join(repo, "node_modules");
    fs.mkdirSync(path.join(packages, "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(packages, "left-pad", "index.js"), "module.exports = 1;\n");
    fs.symlinkSync(packages, path.join(linked, "node_modules"), "dir");
    assert.equal(git(linked, ["status", "--porcelain"]), "?? node_modules", "git lists the link as a new file");

    await check("link: a node_modules link is no unsaved file, on the screen or in the full check", async () => {
      const { scan } = await scanMod.scanWorktreeCleanup(deps);
      const row = scan.rows.find((entry) => entry.path === linked || entry.id === linked);
      assert.deepEqual(row.dirty, { tracked: 0, untracked: 0, inProgress: null });
      const entry = await checkOf(linked);
      assert.deepEqual(codes(entry), []);
      assert.equal(entry.localWork, null, JSON.stringify(entry.localWork));
    });

    await check("link: a real new file still counts, and a folder named node_modules is still read", async () => {
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
      // A file named node_modules is no link.
      fs.writeFileSync(path.join(linked, "docs", "node_modules"), "notes\n");
      assert.equal((await checkOf(linked)).localWork.untracked, 1);
      fs.rmSync(path.join(linked, "docs", "node_modules"));
    });

    await check("link: the removal takes the link out and never what it points at", async () => {
      const entry = await checkOf(linked);
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: [{ repoRoot: repo, path: linked, fingerprint: entry.fingerprint, confirmDirty: false, confirmUnmerged: false }],
        deleteMergedBranches: true,
      });
      assert.equal(result.outcomes[0].status, "removed", JSON.stringify(result.outcomes[0]));
      assert.equal(fs.existsSync(linked), false);
      assert.equal(fs.readFileSync(path.join(packages, "left-pad", "index.js"), "utf8"), "module.exports = 1;\n");
    });

    // ── Every open pull request ────────────────────────────────────────────
    await check("pull requests: a repository with 20 open pull requests gives every row its own", async () => {
      const calls = [];
      const open = Array.from({ length: 20 }, (_, i) => ({
        number: 100 + i,
        title: `Change ${i}`,
        url: `https://github.com/acme/app/pull/${100 + i}`,
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: `feat/change-${i}`,
        isCrossRepository: false,
        headRefOid: "a".repeat(40),
      }));
      const adapter = github.createGitHubCliAdapter({
        resolveBinary: async () => "/usr/bin/gh",
        runCommand: async ({ args }) => {
          calls.push(args);
          if (args[0] === "repo") {
            return { stdout: JSON.stringify({ nameWithOwner: "acme/app", url: "https://github.com/acme/app", defaultBranchRef: { name: "main" } }), stderr: "" };
          }
          const limit = Number(args[args.indexOf("--limit") + 1]);
          const state = args[args.indexOf("--state") + 1];
          return { stdout: JSON.stringify(state === "open" ? open.slice(0, limit) : []), stderr: "" };
        },
      });
      const lists = await reads.readRepoPullRequests(adapter, scratch);
      assert.equal(lists.open.length, 20);
      assert.deepEqual(lists.open.at(-1), { number: 119, url: open[19].url, title: "Change 19", headBranch: "feat/change-19", isDraft: false, isCrossRepository: false });
      const listed = calls.filter((args) => args[0] === "pr");
      assert.equal(listed.length, 2, "one gh call per list");
      const openArgs = listed.find((args) => args.includes("open"));
      assert.ok(Number(openArgs[openArgs.indexOf("--limit") + 1]) >= 100);
      assert.doesNotMatch(openArgs.at(-1), /statusCheckRollup/, "no checks: they are the heavy part");
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
